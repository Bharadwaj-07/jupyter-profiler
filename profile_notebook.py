import nbformat
import time
import traceback
import psutil
import re
import io
import json
import os
from line_profiler import LineProfiler
from contextlib import redirect_stdout

def wrap_notebook_cells_into_function(notebook_path):
    with open(notebook_path, encoding='utf-8') as f:
        nb = nbformat.read(f, as_version=4)

    func_name = 'run_notebook_function'
    wrapped_lines = [f"def {func_name}():"]
    func_line_num = 2  # Starts from line 2 since def line is 1

    cell_line_mapping = {}
    current_line_num = 2

    for cell_idx, cell in enumerate(nb.cells):
        if cell.cell_type != 'code':
            continue

        cell_source_lines = cell.source.splitlines()
        cell_line_mapping[cell_idx] = {}

        for i, line in enumerate(cell_source_lines):
            if line.strip():  # Ignore empty lines completely
                mapped_line = f"    {line}"
                wrapped_lines.append(mapped_line)
                cell_line_mapping[cell_idx][current_line_num] = {
                    "original_line": i + 1,
                    "code": line
                }
                current_line_num += 1

    return '\n'.join(wrapped_lines), func_name, cell_line_mapping

def classify_cell(cell_data):
    total_time = cell_data["total_time"]
    total_hits = cell_data["total_hits"]
    lines = cell_data["lines"]

    # Calculate average time per hit across the cell
    avg_time_per_hit = total_time / total_hits if total_hits else 0

    # Heuristic classification based on line patterns
    loop_keywords = ['for ', 'while ']
    memory_keywords = ['np.zeros', 'np.ones', 'np.empty', 'np.array', 'torch.tensor', 'pd.DataFrame']

    loop_line_count = 0
    memory_line_count = 0

    for line_info in lines.values():
        code = line_info.get("code", "").lower()
        if any(kw in code for kw in loop_keywords):
            loop_line_count += 1
        if any(kw in code for kw in memory_keywords):
            memory_line_count += 1

    # Simple classification rules
    if memory_line_count >= 2:
        return "Memory-Intensive"
    elif loop_line_count >= 2:
        return "Loop-Intensive"
    elif avg_time_per_hit > 1e4:  # You can tweak this threshold
        return "CPU-Intensive"
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

        if func_name in global_ns:
            profiler.add_function(global_ns[func_name])

        profiler.enable_by_count()

        process = psutil.Process()
        mem_before = process.memory_info().rss / (1024 * 1024)
        cpu_before = process.cpu_percent(interval=0.1)

        start_time = time.time()
        global_ns[func_name]()
        elapsed_time = time.time() - start_time

        mem_after = process.memory_info().rss / (1024 * 1024)
        cpu_after = process.cpu_percent(interval=0.1)

        profiler.disable_by_count()

        profile_data["summary"] = {
            "total_execution_time_seconds": elapsed_time,
            "memory_used_mb": mem_after - mem_before,
            "cpu_usage_percent": cpu_after - cpu_before
        }

        buffer = io.StringIO()
        with redirect_stdout(buffer):
            profiler.print_stats()
        stats_output = buffer.getvalue().splitlines()

        for cell_idx in cell_line_mapping:
            profile_data["cells"][str(cell_idx)] = {
                "lines": {},
                "total_time": 0,
                "total_hits": 0
            }

        for line in stats_output:
            match = re.match(r"^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(.*)", line)
            if match:
                traced_line = int(match.group(1))
                hits = int(match.group(2))
                time_val = float(match.group(3))
                time_per_hit = float(match.group(4))
                percent = float(match.group(5))

                for cell_idx, lines in cell_line_mapping.items():
                    if traced_line in lines:
                        cell_line_info = lines[traced_line]
                        original_line = str(cell_line_info["original_line"])
                        code = cell_line_info["code"]

                        profile_data["cells"][str(cell_idx)]["lines"][original_line] = {
                            "code": code.strip(),
                            "hits": hits,
                            "time": time_val,
                            "time_per_hit": time_per_hit,
                            "percent": percent
                        }
                        profile_data["cells"][str(cell_idx)]["total_time"] += time_val
                        profile_data["cells"][str(cell_idx)]["total_hits"] += hits
                        break

        total_time_all = sum(cell["total_time"] for cell in profile_data["cells"].values())
        for cell in profile_data["cells"].values():
            cell["percent_time"] = (cell["total_time"] / total_time_all * 100) if total_time_all > 0 else 0
            cell["classification"] = classify_cell(cell)

        output_path = os.path.abspath(notebook_path.replace('.ipynb', '_profile.json'))
        with open(output_path, 'w') as f:
            json.dump(profile_data, f, indent=2)
        print(f"[profiler] Saved output to: {output_path}")

    except Exception as e:
        print(f"❌ Error: {e}")
        traceback.print_exc()
        profile_data["error"] = str(e)
        profile_data["traceback"] = traceback.format_exc()
        error_path = notebook_path.replace('.ipynb', '_profile_error.json')
        with open(error_path, 'w') as f:
            json.dump(profile_data, f, indent=2)

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("notebook", help="Path to .ipynb file")
    args = parser.parse_args()
    profile_notebook_with_line_profiler(args.notebook)
