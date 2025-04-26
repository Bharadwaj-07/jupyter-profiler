const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

let sharedDecorationType = vscode.window.createTextEditorDecorationType({});
const cellDecorationsMap = new Map();

function activate(context) {
    let hoverProviderRegistered = false;

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

    vscode.workspace.onDidChangeTextDocument((e) => {
        // Optional: clear decorations on edit if needed
        // cellDecorationsMap.delete(e.document.uri.toString());
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

                                    Object.entries(cellData.lines).forEach(([lineNumStr, lineData]) => {
                                        const lineNumber = parseInt(lineNumStr) - 1;
                                        if (lineNumber >= 0 && lineNumber < lines.length) {
                                            const lineLength = lines[lineNumber].length;
                                            decorations.push({
                                                range: new vscode.Range(lineNumber, lineLength, lineNumber, lineLength),
                                                renderOptions: {
                                                    after: {
                                                        contentText: ` ⏱ ${lineData.time.toFixed(2)} µs | ⚡ ${lineData.percent.toFixed(2)}%`,
                                                        color: 'gray',
                                                        fontStyle: 'italic',
                                                        margin: '0 0 0 1rem',
                                                    }
                                                }
                                            });
                                        }
                                    });

                                    const docUri = textDocument.uri.toString();
                                    cellDecorationsMap.set(docUri, decorations);
                                }
                            }

                            // Apply to all currently visible editors
                            vscode.window.visibleTextEditors.forEach(applyDecorationsToEditor);

                            vscode.window.showInformationMessage("✅ Profiler annotations added to current notebook cells");

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
