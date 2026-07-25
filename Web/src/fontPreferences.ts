const systemMonospaceStack = 'ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace';
const diffFontFamilyProperty = "--diffs-font-family";

type FontStyleDeclaration = Pick<CSSStyleDeclaration, "removeProperty" | "setProperty">;

export function normalizedFontFamilies(fontFamilies: string[]) {
  return [...new Set(fontFamilies.map((family) => family.trim()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
}

export function fontFamilyStack(fontFamily: string) {
  if (!fontFamily) {
    return systemMonospaceStack;
  }

  const escapedFamily = fontFamily.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `"${escapedFamily}", ${systemMonospaceStack}`;
}

export function applyDiffFontFamily(style: FontStyleDeclaration, fontFamily: string) {
  if (fontFamily) {
    style.setProperty(diffFontFamilyProperty, fontFamilyStack(fontFamily));
  } else {
    style.removeProperty(diffFontFamilyProperty);
  }
}
