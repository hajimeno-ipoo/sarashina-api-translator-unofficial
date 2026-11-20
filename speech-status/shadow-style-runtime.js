import { useLayoutEffect, useRef } from "react";
import { jsx as renderElement } from "react/jsx-runtime";
export { Fragment, jsxs } from "react/jsx-runtime";

const supportsConstructableStyles =
  typeof ShadowRoot !== "undefined" &&
  "adoptedStyleSheets" in ShadowRoot.prototype &&
  typeof globalThis.CSSStyleSheet?.prototype.replaceSync === "function";

function ShadowStyle({ children }) {
  const anchor = useRef(null);
  useLayoutEffect(() => {
    const shadow = anchor.current.getRootNode();
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(children);
    shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];

    // Border Beam's rotation relies on @property, which browsers register in the document.
    const rules = [...sheet.cssRules].filter(rule => rule.cssText.startsWith("@property --beam-"));
    const ownerDocument = shadow.ownerDocument;
    let propertySheet;
    if (rules.length) {
      propertySheet = new CSSStyleSheet();
      propertySheet.replaceSync(rules.map(rule => rule.cssText).join("\n"));
      ownerDocument.adoptedStyleSheets = [...ownerDocument.adoptedStyleSheets, propertySheet];
    }
    return () => {
      shadow.adoptedStyleSheets = shadow.adoptedStyleSheets.filter(candidate => candidate !== sheet);
      if (propertySheet) {
        ownerDocument.adoptedStyleSheets = ownerDocument.adoptedStyleSheets.filter(candidate => candidate !== propertySheet);
      }
    };
  }, [children]);
  return renderElement("span", { ref: anchor, hidden: true });
}

export function jsx(type, props, key) {
  const component = type === "style" && supportsConstructableStyles ? ShadowStyle : type;
  return renderElement(component, props, key);
}
