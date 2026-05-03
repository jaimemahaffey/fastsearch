import * as vscode from 'vscode';

export class FakeQuickPick<T extends vscode.QuickPickItem> {
  private _items: readonly T[] = [];
  activeItems: readonly T[] = [];
  selectedItems: readonly T[] = [];
  value = '';
  title = '';
  placeholder = '';
  matchOnDescription = false;
  matchOnDetail = false;
  ignoreFocusOut = false;
  busy = false;
  enabled = true;
  showed = false;
  disposed = false;

  private readonly changeValueListeners: Array<(value: string) => void> = [];
  private readonly acceptListeners: Array<() => void> = [];
  private readonly hideListeners: Array<() => void> = [];
  private readonly itemUpdateResolvers: Array<() => void> = [];

  get items(): readonly T[] {
    return this._items;
  }

  set items(value: readonly T[]) {
    this._items = value;
    while (this.itemUpdateResolvers.length > 0) {
      this.itemUpdateResolvers.shift()?.();
    }
  }

  show(): void {
    this.showed = true;
  }

  hide(): void {
    for (const listener of this.hideListeners) {
      listener();
    }
  }

  dispose(): void {
    this.disposed = true;
  }

  onDidChangeValue(listener: (value: string) => void): vscode.Disposable {
    this.changeValueListeners.push(listener);
    return new vscode.Disposable(() => undefined);
  }

  onDidAccept(listener: () => void): vscode.Disposable {
    this.acceptListeners.push(listener);
    return new vscode.Disposable(() => undefined);
  }

  onDidHide(listener: () => void): vscode.Disposable {
    this.hideListeners.push(listener);
    return new vscode.Disposable(() => undefined);
  }

  fireChangeValue(value: string): void {
    this.value = value;
    for (const listener of this.changeValueListeners) {
      listener(value);
    }
  }

  fireAccept(): void {
    for (const listener of this.acceptListeners) {
      listener();
    }
  }

  waitForItemsUpdate(): Promise<void> {
    return new Promise((resolve) => {
      this.itemUpdateResolvers.push(resolve);
    });
  }
}
