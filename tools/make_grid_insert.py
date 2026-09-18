#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["trimesh>=4.4", "numpy>=1.26", "manifold3d>=2.5"]
# ///
"""Build a borderless grid insert (egg-crate divider) for the MAXIMERA drawer.

Only the internal dividers are generated - the drawer walls act as the border.
The result is a single watertight solid in millimetres, ready for a 3D printing
service.

Usage:
    uv run tools/make_grid_insert.py                       # 5x5, 180 mm tall, 3 mm walls
    uv run tools/make_grid_insert.py --cells 4 6 --height 120 -o grid.obj
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import trimesh

# Inner cavity of the MAXIMERA 60x60 drawer, measured by tools/measure_glb.py.
CAVITY_WIDTH_MM = 517.8  # left-right (X)
CAVITY_DEPTH_MM = 491.4  # front-back (Y in the exported part, Z in the drawer)
CAVITY_HEIGHT_MM = 210.6


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("-o", "--output", type=Path, default=Path("grid-insert.obj"), help="output file (.obj or .stl, default: grid-insert.obj)")
    p.add_argument("-c", "--cells", type=int, nargs=2, default=(5, 5), metavar=("NX", "NY"), help="number of cells across and deep (default: 5 5)")
    p.add_argument("-t", "--thickness", type=float, default=3.0, help="wall thickness in mm (default: 3)")
    p.add_argument("-H", "--height", type=float, default=180.0, help="wall height in mm (default: 180)")
    p.add_argument("--size", type=float, nargs=2, metavar=("WIDTH", "DEPTH"), help="outer footprint in mm (default: drawer cavity minus clearance)")
    p.add_argument("--clearance", type=float, default=1.0, help="gap left on each side of the cavity in mm (default: 1)")
    return p.parse_args(argv)


def wall(size: tuple[float, float, float], centre: tuple[float, float, float]) -> trimesh.Trimesh:
    box = trimesh.creation.box(extents=size)
    box.apply_translation(centre)
    return box


def build_grid(width: float, depth: float, height: float, thickness: float, nx: int, ny: int) -> trimesh.Trimesh:
    """Interior dividers of an nx x ny grid, unioned into one solid."""
    walls = []
    for i in range(1, nx):
        x = -width / 2 + i * width / nx
        walls.append(wall((thickness, depth, height), (x, 0.0, height / 2)))
    for j in range(1, ny):
        y = -depth / 2 + j * depth / ny
        walls.append(wall((width, thickness, height), (0.0, y, height / 2)))
    if not walls:
        raise ValueError("a grid needs at least 2 cells in one direction")
    return trimesh.boolean.union(walls)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    nx, ny = args.cells
    if nx < 1 or ny < 1:
        print("error: cell counts must be >= 1", file=sys.stderr)
        return 1

    if args.size:
        width, depth = args.size
    else:
        width = CAVITY_WIDTH_MM - 2 * args.clearance
        depth = CAVITY_DEPTH_MM - 2 * args.clearance

    mesh = build_grid(width, depth, args.height, args.thickness, nx, ny)
    mesh.merge_vertices()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    mesh.export(args.output)

    cell_w = (width - (nx - 1) * args.thickness) / nx
    cell_d = (depth - (ny - 1) * args.thickness) / ny
    print(f"wrote {args.output}")
    print(f"grid        : {nx} x {ny} cells, {args.thickness:g} mm walls, {args.height:g} mm tall")
    print(f"footprint   : {width:.1f} x {depth:.1f} mm (cavity {CAVITY_WIDTH_MM} x {CAVITY_DEPTH_MM} mm)")
    print(f"cell opening: {cell_w:.1f} x {cell_d:.1f} mm")
    print(f"mesh        : {len(mesh.faces)} triangles, watertight={mesh.is_watertight}, volume={mesh.volume / 1000:.0f} cm3")
    if args.height > CAVITY_HEIGHT_MM:
        print(f"warning: {args.height:g} mm is taller than the {CAVITY_HEIGHT_MM} mm cavity", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
