import nbformat
import time
import traceback
import psutil
import re
import io
import os
import json
from line_profiler import LineProfiler
from contextlib import redirect_stdout

def wrap_notebook_cells_into_function(notebook_path):
    with open(notebook_path, encoding='utf-8') as f:
        nb = nbformat.read(f, as_version=4)

    func_name = 'run_notebook_function'
    wrapped_lines = [f"def {func_name}():"]
    cell_line_mapping = {}
    current_line_num = 2  # Starts from line 2 (after function def)

    for cell_idx, cell in enumerate(nb.cells):
        if cell.cell_type != 'code':
            continue

        cell_source_lines = cell.source.splitlines()
        cell_line_mapping[cell_idx] = {}

        # Add cell separator comment (not counted as real line)
        if cell_idx > 0:
            wrapped_lines.append(f"    # Cell {cell_idx} separator")
            current_line_num += 1

        for i, line in enumerate(cell_source_lines):
            if line.strip():
                wrapped_lines.append(f"    {line}")
                cell_line_mapping[cell_idx][current_line_num] = {
                    "original_line": i + 1,
                    "code": line.strip()
                }
                current_line_num += 1

    return '\n'.join(wrapped_lines), func_name, cell_line_mapping

def classify_cell(cell_data, global_memory_delta):
    total_time = cell_data["total_time"]
    total_hits = cell_data["total_hits"]
    lines = cell_data["lines"]

    avg_time_per_hit = (total_time / total_hits * 1e6) if total_hits else 0  # µs
    percent_runtime = cell_data.get("percent_time", 0)
    mem_impact = cell_data.get("memory_delta_mb", 0) / global_memory_delta if global_memory_delta > 0 else 0

    if percent_runtime > 30:
        return "Performance-Critical"
    elif avg_time_per_hit > 1e3:  # >1ms per hit
        return "CPU-Intensive"
    elif total_hits > 1e4 and avg_time_per_hit < 100:
        return "Loop-Intensive"
    elif mem_impact > 0.3:
        return "Memory-Intensive"

    loop_keywords = ['for ', 'while ', 'iteritems(', 'itertuples(', 'iterrows(']
    io_keywords = ['pd.read_', 'np.load', 'np.save', 'pickle.', 'open(', 'h5py.File']

    for line_info in lines.values():
        code = line_info.get("code", "").lower()
        if any(kw in code for kw in io_keywords):
            return "I/O-Intensive"
        if any(kw in code for kw in loop_keywords) and avg_time_per_hit > 1e4:
            return "Loop-Intensive"

    return "Normal"

def profile_notebook_with_line_profiler(notebook_path):
    wrapped_code, func_name, cell_line_mapping = wrap_notebook_cells_into_function(notebook_path)

    profiler = LineProfiler()
    global_ns = {}
    profile_data = {
        "metadata": {
            "notebook_path": notebook_path,
            "profile_timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
            "function_name": func_name
        },
        "cells": {},
        "summary": {}
    }

    try:
        exec(wrapped_code, global_ns)

        if func_name not in global_ns:
            raise ValueError(f"Function {func_name} not found")

        # Memory tracking wrapper
        def wrapped_func():
            process = psutil.Process()
            mem_before = process.memory_info().rss / (1024 * 1024)
            result = global_ns[func_name]()
            mem_after = process.memory_info().rss / (1024 * 1024)
            return result, mem_after - mem_before

        profiler.add_function(global_ns[func_name])
        profiler.enable_by_count()

        start_time = time.time()
        _, memory_delta = wrapped_func()
        elapsed_time = time.time() - start_time

        profiler.disable_by_count()

        profile_data["summary"] = {
            "total_execution_time_seconds": elapsed_time,
            "memory_used_mb": memory_delta,
            "peak_memory_mb": psutil.Process().memory_info().rss / (1024 * 1024)
        }

        buffer = io.StringIO()
        with redirect_stdout(buffer):
            profiler.print_stats()

        # Initialize empty cells first
        for cell_idx in cell_line_mapping:
            profile_data["cells"][str(cell_idx)] = {
                "lines": {},
                "total_time": 0,
                "total_hits": 0,
                "memory_delta_mb": 0
            }

        # Fill in line info
        for line in buffer.getvalue().splitlines():
            match = re.match(r"^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(.*)", line)
            if match:
                traced_line = int(match.group(1))
                hits = int(match.group(2))
                time_val = float(match.group(3))
                time_per_hit = float(match.group(4))
                percent = float(match.group(5))

                for cell_idx, lines in cell_line_mapping.items():
                    if traced_line in lines:
                        orig_line = str(lines[traced_line]["original_line"])
                        cell_data = profile_data["cells"][str(cell_idx)]

                        cell_data["lines"][orig_line] = {
                            "code": lines[traced_line]["code"],
                            "hits": hits,
                            "time": time_val,
                            "time_per_hit": time_per_hit,
                            "percent": 0.0  # will adjust below
                        }
                        cell_data["total_time"] += time_val
                        cell_data["total_hits"] += hits
                        break

        total_time_all = sum(cell["total_time"] for cell in profile_data["cells"].values())

        # Correct percentage inside lines and per cell
        for cell_idx, cell in profile_data["cells"].items():
            total_cell_time = cell["total_time"]
            if total_cell_time > 0:
                for line_data in cell["lines"].values():
                    line_data["percent"] = (line_data["time"] / total_cell_time) * 100
            else:
                for line_data in cell["lines"].values():
                    line_data["percent"] = 0.0

            cell["percent_time"] = (total_cell_time / total_time_all * 100) if total_time_all > 0 else 0
            cell["classification"] = classify_cell(cell, memory_delta)

        output_path = os.path.abspath(notebook_path.replace('.ipynb', '_profile.json'))
        with open(output_path, 'w') as f:
            json.dump(profile_data, f, indent=2)
        print(f"Profile saved to {output_path}")

    except Exception as e:
        print(f"Error: {e}")
        traceback.print_exc()
        profile_data["error"] = str(e)
        error_path = notebook_path.replace('.ipynb', '_profile_error.json')
        with open(error_path, 'w') as f:
            json.dump(profile_data, f, indent=2)

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("notebook", help="Path to .ipynb file")
    args = parser.parse_args()
    profile_notebook_with_line_profiler(args.notebook)
