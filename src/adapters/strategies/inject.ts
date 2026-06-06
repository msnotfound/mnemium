import type { SiteAdapter } from "@/shared/interfaces";

export type EditorKind = SiteAdapter["capability"]["editor"];

export interface InjectionResult {
  ok: boolean;
  usedClipboardFallback: boolean;
}

export async function injectWithClipboardFallback(
  text: string,
  locateComposer: () => HTMLElement | null,
  editor: EditorKind,
): Promise<InjectionResult> {
  const ok = injectIntoComposer(text, locateComposer, editor);
  if (ok) {
    return { ok: true, usedClipboardFallback: false };
  }

  const copied = await copyToClipboard(text);
  return { ok: copied, usedClipboardFallback: copied };
}

export function injectIntoComposer(
  text: string,
  locateComposer: () => HTMLElement | null,
  editor: EditorKind,
): boolean {
  const composer = locateComposer();
  if (composer === null) {
    return false;
  }

  if (editor === "textarea") {
    return insertIntoTextControl(composer, text);
  }

  if (editor === "prosemirror" || editor === "lexical" || editor === "contenteditable") {
    return insertIntoRichEditor(composer, text);
  }

  return false;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return fallbackCopyWithSelection(text);
  }
}

function insertIntoTextControl(target: HTMLElement, text: string): boolean {
  const control = findTextControl(target);
  if (control === null) {
    return false;
  }

  const start = control.selectionStart ?? control.value.length;
  const end = control.selectionEnd ?? control.value.length;
  const prefix = control.value.slice(0, start);
  const suffix = control.value.slice(end);
  const nextValue = `${prefix}${text}${suffix}`;

  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), "value")?.set;
  if (setter === undefined) {
    return false;
  }

  control.focus();
  setter.call(control, nextValue);
  const cursor = prefix.length + text.length;
  control.setSelectionRange(cursor, cursor);
  control.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
  return control.value === nextValue;
}

function insertIntoRichEditor(target: HTMLElement, text: string): boolean {
  const editor = findEditable(target);
  if (editor === null) {
    return false;
  }

  editor.focus();

  const before = normalizedText(editor);
  const inserted = document.execCommand("insertText", false, text);
  editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  if (inserted && normalizedText(editor) !== before) {
    return true;
  }

  return pasteIntoRichEditor(editor, text, before);
}

function pasteIntoRichEditor(editor: HTMLElement, text: string, before: string): boolean {
  const clipboard = new DataTransfer();
  clipboard.setData("text/plain", text);

  const beforeInput = new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    inputType: "insertFromPaste",
    data: text,
  });
  editor.dispatchEvent(beforeInput);

  const paste = new ClipboardEvent("paste", {
    bubbles: true,
    cancelable: true,
    clipboardData: clipboard,
  });
  editor.dispatchEvent(paste);
  editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: text }));

  return normalizedText(editor) !== before;
}

function fallbackCopyWithSelection(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.append(textarea);
  textarea.select();

  try {
    return document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

function findTextControl(target: HTMLElement): HTMLTextAreaElement | HTMLInputElement | null {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    return target;
  }

  return target.querySelector("textarea, input[type='text'], input:not([type])");
}

function findEditable(target: HTMLElement): HTMLElement | null {
  if (target.isContentEditable) {
    return target;
  }

  return target.querySelector<HTMLElement>(
    "[contenteditable='true'], [role='textbox'], .ProseMirror, [data-lexical-editor='true']",
  );
}

function normalizedText(element: HTMLElement): string {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    return element.value;
  }

  return element.textContent ?? "";
}
