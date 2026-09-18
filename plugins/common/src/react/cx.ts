export type ClassValue =
  | string
  | number
  | false
  | null
  | undefined
  | ClassValue[]
  | Record<string, unknown>;

function appendClassValue(value: ClassValue, classes: string[]): void {
  if (!value) return;

  if (typeof value === "string" || typeof value === "number") {
    classes.push(String(value));
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => appendClassValue(item, classes));
    return;
  }

  Object.entries(value).forEach(([className, enabled]) => {
    if (enabled) classes.push(className);
  });
}

export function cx(...values: ClassValue[]): string {
  const classes: string[] = [];
  values.forEach((value) => appendClassValue(value, classes));
  return classes.join(" ");
}
