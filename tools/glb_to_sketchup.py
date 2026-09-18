#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["trimesh>=4.4", "numpy>=1.26", "pillow>=10.0"]
# ///
"""Convert a glTF/GLB model into a SketchUp-importable file.

COLLADA (.dae) is the default: it is the only textured format every SketchUp
edition (Free/Web, Make, Pro) can import. OBJ is offered for SketchUp Pro.

Usage:
    uv run tools/glb_to_sketchup.py maximera-30285025-rqp3.glb
    uv run tools/glb_to_sketchup.py model.glb --format obj --unit mm
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from xml.sax.saxutils import escape

import numpy as np
import trimesh

# glTF is metres + Y-up; SketchUp is Z-up.
UNITS = {"m": 1.0, "cm": 0.01, "mm": 0.001, "in": 0.0254, "ft": 0.3048}
Y_UP_TO_Z_UP = np.array(
    [[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, 0], [0, 0, 0, 1]], dtype=np.float64
)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("input", type=Path, help="source .glb or .gltf file")
    p.add_argument("-o", "--output", type=Path, help="output file (default: <input>.dae next to the source)")
    p.add_argument("-f", "--format", choices=("dae", "obj"), default="dae", help="target format (default: dae)")
    p.add_argument("-u", "--unit", choices=tuple(UNITS), default="m", help="unit the exported numbers are expressed in (default: m)")
    p.add_argument("-s", "--scale", type=float, default=1.0, help="extra uniform scale factor applied to the geometry")
    p.add_argument("--keep-y-up", action="store_true", help="do not rotate Y-up (glTF) to Z-up (SketchUp)")
    p.add_argument("--no-textures", action="store_true", help="export flat colours only, skip texture images")
    return p.parse_args(argv)


def transform_normals(normals: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    rotated = normals @ np.linalg.inv(matrix[:3, :3])  # inverse-transpose, transposed back
    lengths = np.linalg.norm(rotated, axis=1, keepdims=True)
    return rotated / np.where(lengths == 0, 1.0, lengths)


def load_meshes(path: Path) -> list[tuple[str, trimesh.Trimesh, np.ndarray]]:
    """Load the scene and return world-space triangle meshes with their names and normals."""
    scene = trimesh.load(path, force="scene", process=False)
    out: list[tuple[str, trimesh.Trimesh, np.ndarray]] = []
    for name, geom in scene.geometry.items():
        if not isinstance(geom, trimesh.Trimesh):
            continue
        normals = np.asarray(geom.vertex_normals, dtype=np.float64)
        for node in scene.graph.nodes_geometry:
            transform, geom_name = scene.graph[node]
            if geom_name != name:
                continue
            mesh = geom.copy()
            mesh.apply_transform(transform)
            out.append((str(node), mesh, transform_normals(normals, transform)))
    return out


def sanitize(name: str) -> str:
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in name)
    return safe or "object"


def texture_image(mesh: trimesh.Trimesh):
    """Return the base-colour PIL image of a mesh, if any."""
    material = getattr(mesh.visual, "material", None)
    if material is None:
        return None
    return getattr(material, "baseColorTexture", None) or getattr(material, "image", None)


def diffuse_colour(mesh: trimesh.Trimesh) -> tuple[float, float, float, float]:
    material = getattr(mesh.visual, "material", None)
    raw = getattr(material, "baseColorFactor", None)
    if raw is None:
        raw = getattr(material, "diffuse", None)
    if raw is None:
        return (0.8, 0.8, 0.8, 1.0)
    values = np.asarray(raw, dtype=np.float64).ravel()
    if values.max(initial=0.0) > 1.0:  # stored as 0-255
        values = values / 255.0
    rgba = np.ones(4)
    rgba[: min(4, values.size)] = values[:4]
    return tuple(float(v) for v in rgba)


def uv_array(mesh: trimesh.Trimesh) -> np.ndarray | None:
    uv = getattr(mesh.visual, "uv", None)
    if uv is None or len(uv) != len(mesh.vertices):
        return None
    uv = np.asarray(uv, dtype=np.float64).copy()
    uv[:, 1] = 1.0 - uv[:, 1]  # glTF V points down, COLLADA/OBJ point up
    return uv


def save_texture(image, directory: Path, stem: str) -> str:
    directory.mkdir(parents=True, exist_ok=True)
    if image.mode in ("RGBA", "LA", "P"):
        image = image.convert("RGBA") if image.mode != "P" else image.convert("RGB")
    suffix = ".png" if image.mode == "RGBA" else ".jpg"
    filename = f"{stem}{suffix}"
    path = directory / filename
    image.save(path, quality=95) if suffix == ".jpg" else image.save(path)
    return f"{directory.name}/{filename}"


def floats(values: np.ndarray) -> str:
    return " ".join(f"{v:.6g}" for v in np.asarray(values).ravel())


def ints(values: np.ndarray) -> str:
    return " ".join(str(int(v)) for v in np.asarray(values).ravel())


def source_xml(source_id: str, data: np.ndarray, params: str) -> str:
    count, stride = data.shape
    accessor_params = "".join(f'<param name="{p}" type="float"/>' for p in params)
    return (
        f'<source id="{source_id}">'
        f'<float_array id="{source_id}-array" count="{count * stride}">{floats(data)}</float_array>'
        f'<technique_common><accessor source="#{source_id}-array" count="{count}" stride="{stride}">'
        f"{accessor_params}</accessor></technique_common></source>"
    )


def write_collada(entries: list[dict], out_path: Path, unit: str) -> None:
    images, effects, materials, geometries, nodes = [], [], [], [], []

    for entry in entries:
        name, mesh, texture = entry["name"], entry["mesh"], entry["texture"]
        mat_id, geo_id = f"{name}-material", f"{name}-geometry"
        r, g, b, a = entry["colour"]

        if texture:
            images.append(f'<image id="{name}-image" name="{name}-image"><init_from>{escape(texture)}</init_from></image>')
            diffuse = f'<texture texture="{name}-sampler" texcoord="UVSET0"/>'
            params = (
                f'<newparam sid="{name}-surface"><surface type="2D">'
                f'<init_from>{name}-image</init_from></surface></newparam>'
                f'<newparam sid="{name}-sampler"><sampler2D>'
                f'<source>{name}-surface</source></sampler2D></newparam>'
            )
        else:
            diffuse = f"<color>{r:.6g} {g:.6g} {b:.6g} {a:.6g}</color>"
            params = ""

        effects.append(
            f'<effect id="{mat_id}-effect"><profile_COMMON>{params}<technique sid="common"><lambert>'
            f"<diffuse>{diffuse}</diffuse>"
            f"<transparency><float>1</float></transparency>"
            f"</lambert></technique></profile_COMMON></effect>"
        )
        materials.append(
            f'<material id="{mat_id}" name="{escape(name)}">'
            f'<instance_effect url="#{mat_id}-effect"/></material>'
        )

        sources = [
            source_xml(f"{name}-positions", entry["vertices"], "XYZ"),
            source_xml(f"{name}-normals", entry["normals"], "XYZ"),
        ]
        inputs = (
            f'<input semantic="VERTEX" source="#{name}-vertices" offset="0"/>'
            f'<input semantic="NORMAL" source="#{name}-normals" offset="0"/>'
        )
        if entry["uv"] is not None:
            sources.append(source_xml(f"{name}-uv", entry["uv"], "ST"))
            inputs += f'<input semantic="TEXCOORD" source="#{name}-uv" offset="0" set="0"/>'

        faces = entry["faces"]
        geometries.append(
            f'<geometry id="{geo_id}" name="{escape(name)}"><mesh>'
            + "".join(sources)
            + f'<vertices id="{name}-vertices">'
            f'<input semantic="POSITION" source="#{name}-positions"/></vertices>'
            + f'<triangles material="{mat_id}" count="{len(faces)}">{inputs}'
            f"<p>{ints(faces)}</p></triangles>"
            "</mesh></geometry>"
        )

        bind_uv = (
            '<bind_vertex_input semantic="UVSET0" input_semantic="TEXCOORD" input_set="0"/>'
            if entry["uv"] is not None
            else ""
        )
        nodes.append(
            f'<node id="{name}-node" name="{escape(name)}" type="NODE">'
            f'<instance_geometry url="#{geo_id}"><bind_material><technique_common>'
            f'<instance_material symbol="{mat_id}" target="#{mat_id}">{bind_uv}</instance_material>'
            "</technique_common></bind_material></instance_geometry></node>"
        )

    document = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">'
        "<asset><contributor><authoring_tool>glb_to_sketchup.py</authoring_tool></contributor>"
        f'<unit name="{unit}" meter="{UNITS[unit]:.6g}"/><up_axis>Z_UP</up_axis></asset>'
        + (f"<library_images>{''.join(images)}</library_images>" if images else "")
        + f"<library_effects>{''.join(effects)}</library_effects>"
        f"<library_materials>{''.join(materials)}</library_materials>"
        f"<library_geometries>{''.join(geometries)}</library_geometries>"
        '<library_visual_scenes><visual_scene id="scene" name="scene">'
        f"{''.join(nodes)}</visual_scene></library_visual_scenes>"
        '<scene><instance_visual_scene url="#scene"/></scene>'
        "</COLLADA>\n"
    )
    out_path.write_text(document, encoding="utf-8")


def write_obj(entries: list[dict], out_path: Path) -> None:
    mtl_path = out_path.with_suffix(".mtl")
    obj_lines = ["# exported by glb_to_sketchup.py", f"mtllib {mtl_path.name}"]
    mtl_lines: list[str] = []
    offset_v = offset_vt = offset_vn = 1

    for entry in entries:
        name, texture = entry["name"], entry["texture"]
        r, g, b, _ = entry["colour"]
        mtl_lines += [f"newmtl {name}", f"Kd {r:.6g} {g:.6g} {b:.6g}", "Ka 0 0 0", "d 1", "illum 1"]
        if texture:
            mtl_lines.append(f"map_Kd {texture}")
        mtl_lines.append("")

        obj_lines.append(f"o {name}")
        obj_lines += [f"v {x:.6g} {y:.6g} {z:.6g}" for x, y, z in entry["vertices"]]
        if entry["uv"] is not None:
            obj_lines += [f"vt {u:.6g} {v:.6g}" for u, v in entry["uv"]]
        obj_lines += [f"vn {x:.6g} {y:.6g} {z:.6g}" for x, y, z in entry["normals"]]
        obj_lines.append(f"usemtl {name}")
        for face in entry["faces"]:
            parts = []
            for idx in face:
                v = offset_v + int(idx)
                vt = f"{offset_vt + int(idx)}" if entry["uv"] is not None else ""
                parts.append(f"{v}/{vt}/{offset_vn + int(idx)}")
            obj_lines.append("f " + " ".join(parts))

        count = len(entry["vertices"])
        offset_v += count
        offset_vn += count
        if entry["uv"] is not None:
            offset_vt += count

    out_path.write_text("\n".join(obj_lines) + "\n", encoding="utf-8")
    mtl_path.write_text("\n".join(mtl_lines) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if not args.input.is_file():
        print(f"error: {args.input} not found", file=sys.stderr)
        return 1

    out_path = args.output or args.input.with_suffix(f".{args.format}")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    texture_dir = out_path.parent / f"{out_path.stem}_textures"

    meshes = load_meshes(args.input)
    if not meshes:
        print("error: no triangle geometry found in the source file", file=sys.stderr)
        return 1

    factor = args.scale / UNITS[args.unit]
    entries, used_names = [], set()
    for index, (raw_name, mesh, normals) in enumerate(meshes):
        if not args.keep_y_up:
            mesh.apply_transform(Y_UP_TO_Z_UP)
            normals = transform_normals(normals, Y_UP_TO_Z_UP)
        name = sanitize(raw_name)
        while name in used_names:
            name = f"{name}_{index}"
        used_names.add(name)

        image = None if args.no_textures else texture_image(mesh)
        entries.append(
            {
                "name": name,
                "mesh": mesh,
                "vertices": np.asarray(mesh.vertices, dtype=np.float64) * factor,
                "normals": normals,
                "uv": uv_array(mesh),
                "faces": np.asarray(mesh.faces, dtype=np.int64),
                "colour": diffuse_colour(mesh),
                "texture": save_texture(image, texture_dir, name) if image is not None else None,
            }
        )

    if args.format == "dae":
        write_collada(entries, out_path, args.unit)
    else:
        write_obj(entries, out_path)

    triangles = sum(len(e["faces"]) for e in entries)
    size = np.ptp(np.vstack([e["vertices"] for e in entries]), axis=0)
    print(f"wrote {out_path} ({len(entries)} object(s), {triangles} triangles)")
    print(f"bounding box: {size[0]:.4g} x {size[1]:.4g} x {size[2]:.4g} {args.unit}")
    if any(e["texture"] for e in entries):
        print(f"textures in {texture_dir}/ - keep this folder next to the model when importing")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
