const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

let sharedDecorationType = vscode.window.createTextEditorDecorationType({});
const cellDecorationsMap = new Map();

function activate(context) {
    let hoverProviderRegistered = false;
    function formatTime(timeInMicroseconds) {
        if (!timeInMicroseconds) return 'N/A';
        timeInMicroseconds = parseFloat(timeInMicroseconds)/10;
        const timeInMilliseconds = timeInMicroseconds / 1000;
        const timeInSeconds = timeInMilliseconds / 1000;
        const timeInMinutes = timeInSeconds / 60;
    
        if (timeInMinutes >= 1) {
            // If time is greater than or equal to a minute
            return `${timeInMinutes.toFixed(2)} min`;
        } else if (timeInSeconds >= 1) {
            // If time is greater than or equal to a second but less than a minute
            return `${timeInSeconds.toFixed(2)} s`;
        } else if (timeInMilliseconds >= 1) {
            // If time is greater than or equal to a millisecond but less than a second
            return `${timeInMilliseconds.toFixed(2)} ms`;
        } else {
            // Time is too small to convert (in microseconds)
            return `${timeInMicroseconds.toFixed(2)} µs`;
        }
    }
    
    
    
    const classifyCell = (cellData) => {
        const percent_runtime = cellData.percent_time || 0;
        const avg_time_per_hit = (cellData.total_time || 0) / (cellData.total_hits || 1);
        const total_hits = cellData.total_hits || 0;
        const mem_impact = cellData.memory_delta_mb || 0;

        if (percent_runtime > 30) {
            return "Performance-Critical";
        } else if (avg_time_per_hit > 1e3) { // >1ms
            return "CPU-Intensive";
        } else if (total_hits > 1e4 && avg_time_per_hit < 100) {
            return "Loop-Intensive";
        } else if (mem_impact > 0.3) {
            return "Memory-Intensive";
        } else {
            return "Normal";
        }
    };

    const colorForCategory = (category) => {
        switch (category) {
            case "Performance-Critical":
                return "red";
            case "CPU-Intensive":
                return "orange";
            case "Loop-Intensive":
                return "green";
            case "Memory-Intensive":
                return "purple";
            default:
                return "gray";
        }
    };

    const applyDecorationsToEditor = (editor) => {
        const docUri = editor.document.uri.toString();
        const decorations = cellDecorationsMap.get(docUri);
        if (decorations) {
            editor.setDecorations(sharedDecorationType, decorations);
        } else {
            editor.setDecorations(sharedDecorationType, []); // Clear if none
        }
    };

    vscode.window.onDidChangeVisibleTextEditors((editors) => {
        editors.forEach(applyDecorationsToEditor);
    });

    context.subscriptions.push(
        vscode.commands.registerCommand('jupyterProfiler.profileNotebook', async () => {
            const notebookEditor = vscode.window.activeNotebookEditor;

            if (!notebookEditor || !notebookEditor.notebook.uri.fsPath.endsWith('.ipynb')) {
                vscode.window.showErrorMessage("Please open a Jupyter Notebook (.ipynb) file.");
                return;
            }

            const filePath = notebookEditor.notebook.uri.fsPath;
            const pythonScript = path.join(context.extensionPath, 'profile_notebook.py');
            const profilerOutput = filePath.replace('.ipynb', '_profile.json');

            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Profiling notebook...",
                cancellable: false
            }, async () => {
                return new Promise((resolve) => {
                    exec(`python "${pythonScript}" "${filePath}"`, async (error, stdout, stderr) => {
                        if (error) {
                            vscode.window.showErrorMessage("Profiler error: " + error.message);
                            return resolve();
                        }

                        if (!fs.existsSync(profilerOutput)) {
                            vscode.window.showWarningMessage("Profiler output not found at: " + profilerOutput);
                            return resolve();
                        }

                        try {
                            cellDecorationsMap.clear();

                            const raw = fs.readFileSync(profilerOutput, 'utf-8');
                            const profilingData = JSON.parse(raw);
                            const profilingCells = profilingData.cells;
                            console.log(raw);

                            const notebook = notebookEditor.notebook;
                            const allCells = notebook.getCells();

                            for (let cellIndex = 0; cellIndex < allCells.length; cellIndex++) {
                                const cell = notebook.cellAt(cellIndex);
                                const cellData = profilingCells[cellIndex];

                                if (
                                    cell.kind === vscode.NotebookCellKind.Code &&
                                    cellData &&
                                    cell.document &&
                                    cell.document.getText
                                ) {
                                    const textDocument = cell.document;
                                    const lines = textDocument.getText().split('\n');

                                    const decorations = [];

                                    // Inline stats decoration (for each line)
                                    Object.entries(cellData.lines).forEach(([lineNumStr, lineData]) => {
                                        const lineNumber = parseInt(lineNumStr) - 1;
                                        if (lineNumber >= 0 && lineNumber < lines.length) {
                                            const lineLength = lines[lineNumber].length;

                                            const category = classifyCell(lineData);
                                            const color = colorForCategory(category);

                                            decorations.push({
                                                range: new vscode.Range(lineNumber, lineLength, lineNumber, lineLength),
                                                renderOptions: {
                                                    after: {
                                                        contentText: `⏱ ${formatTime(lineData.time)}  | ⚡ ${lineData.percent ? lineData.percent.toFixed(2) : 'N/A'}%`,
                                                        color: color,
                                                        fontStyle: 'italic',
                                                        margin: '0 0 0 1rem',
                                                        fontWeight: 'bold',
                                                    }
                                                }
                                            });
                                        }
                                    });

                                    // Cell summary stats decoration
                                    const totalTime = cellData.total_time || 0;
                                    const totalHits = cellData.total_hits || 0;
                                    const category = classifyCell(cellData);
                                    const color = colorForCategory(category);

                                    const summaryText = `Total time: ⏱ ${formatTime(totalTime)} | Total hits: ${totalHits} | Classification: ${category}`;

                                    const lastLineIndex = lines.length - 1;
                                    const lastLineLength = lines[lastLineIndex].length;

                                    decorations.push({
                                        range: new vscode.Range(lastLineIndex, lastLineLength, lastLineIndex, lastLineLength),
                                        renderOptions: {
                                            after: {
                                                contentText: ` | ${summaryText}`,
                                                color: color,
                                                fontWeight: 'bold',
                                                fontStyle: 'italic',
                                                margin: '0 0 0 1rem',
                                            }
                                        }
                                    });

                                    const docUri = textDocument.uri.toString();
                                    cellDecorationsMap.set(docUri, decorations);
                                }
                            }

                            vscode.window.visibleTextEditors.forEach(applyDecorationsToEditor);

                            vscode.window.showInformationMessage("✅ Profiler annotations added to notebook cells");

                            if (!hoverProviderRegistered) {
                                context.subscriptions.push(
                                    vscode.languages.registerHoverProvider('python', {
                                        provideHover(document, position) {
                                            const docUri = document.uri.toString();
                                            const decorations = cellDecorationsMap.get(docUri);
                                            if (decorations) {
                                                const match = decorations.find(d => d.range.start.line === position.line);
                                                if (match) {
                                                    return new vscode.Hover(match.renderOptions.after.contentText);
                                                }
                                            }
                                            return null;
                                        }
                                    })
                                );
                                hoverProviderRegistered = true;
                            }
                        } catch (err) {
                            vscode.window.showErrorMessage("Failed to parse profiler output: " + err.message);
                        }

                        resolve();
                    });
                });
            });
        })
    );
}

function deactivate() {
    sharedDecorationType.dispose();
    cellDecorationsMap.clear();
}

module.exports = {
    activate,
    deactivate
};
