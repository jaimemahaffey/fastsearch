export type RestorableProperty<T extends object, K extends keyof T> = {
  target: T;
  key: K;
  descriptor: PropertyDescriptor | undefined;
};

export function patchProperty<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K]
): RestorableProperty<T, K> {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, {
    configurable: true,
    writable: true,
    value
  });
  return { target, key, descriptor };
}

export function restoreProperty<T extends object, K extends keyof T>(restorable: RestorableProperty<T, K>): void {
  if (restorable.descriptor) {
    Object.defineProperty(restorable.target, restorable.key, restorable.descriptor);
    return;
  }

  delete restorable.target[restorable.key];
}
