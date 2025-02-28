import {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "./element/types";
import { BinaryFiles } from "./types";
import { SVG_EXPORT_TAG } from "./scene/export";
import { tryParseSpreadsheet, Spreadsheet, VALID_SPREADSHEET } from "./charts";
import { EXPORT_DATA_TYPES, MIME_TYPES } from "./constants";
import { isInitializedImageElement } from "./element/typeChecks";
import { deepCopyElement } from "./element/newElement";
import { mutateElement } from "./element/mutateElement";
import { getContainingFrame } from "./frame";
import { isPromiseLike, isTestEnv } from "./utils";

type ElementsClipboard = {
  type: typeof EXPORT_DATA_TYPES.excalidrawClipboard;
  elements: readonly NonDeletedExcalidrawElement[];
  files: BinaryFiles | undefined;
};

export type PastedMixedContent = { type: "text" | "imageUrl"; value: string }[];

export interface ClipboardData {
  spreadsheet?: Spreadsheet;
  elements?: readonly ExcalidrawElement[];
  files?: BinaryFiles;
  text?: string;
  mixedContent?: PastedMixedContent;
  errorMessage?: string;
  programmaticAPI?: boolean;
}

let CLIPBOARD = "";
let PREFER_APP_CLIPBOARD = false;

export const probablySupportsClipboardReadText =
  "clipboard" in navigator && "readText" in navigator.clipboard;

export const probablySupportsClipboardWriteText =
  "clipboard" in navigator && "writeText" in navigator.clipboard;

export const probablySupportsClipboardBlob =
  "clipboard" in navigator &&
  "write" in navigator.clipboard &&
  "ClipboardItem" in window &&
  "toBlob" in HTMLCanvasElement.prototype;

const clipboardContainsElements = (
  contents: any,
): contents is { elements: ExcalidrawElement[]; files?: BinaryFiles } => {
  if (
    [
      EXPORT_DATA_TYPES.excalidraw,
      EXPORT_DATA_TYPES.excalidrawClipboard,
      EXPORT_DATA_TYPES.excalidrawClipboardWithAPI,
    ].includes(contents?.type) &&
    Array.isArray(contents.elements)
  ) {
    return true;
  }
  return false;
};

export const copyToClipboard = async (
  elements: readonly NonDeletedExcalidrawElement[],
  files: BinaryFiles | null,
) => {
  const framesToCopy = new Set(
    elements.filter((element) => element.type === "frame"),
  );
  let foundFile = false;

  const _files = elements.reduce((acc, element) => {
    if (isInitializedImageElement(element)) {
      foundFile = true;
      if (files && files[element.fileId]) {
        acc[element.fileId] = files[element.fileId];
      }
    }
    return acc;
  }, {} as BinaryFiles);

  if (foundFile && !files) {
    console.warn(
      "copyToClipboard: attempting to file element(s) without providing associated `files` object.",
    );
  }

  // select binded text elements when copying
  const contents: ElementsClipboard = {
    type: EXPORT_DATA_TYPES.excalidrawClipboard,
    elements: elements.map((element) => {
      if (
        getContainingFrame(element) &&
        !framesToCopy.has(getContainingFrame(element)!)
      ) {
        const copiedElement = deepCopyElement(element);
        mutateElement(copiedElement, {
          frameId: null,
        });
        return copiedElement;
      }

      return element;
    }),
    files: files ? _files : undefined,
  };
  const json = JSON.stringify(contents);

  if (isTestEnv()) {
    return json;
  }

  CLIPBOARD = json;

  try {
    PREFER_APP_CLIPBOARD = false;
    await copyTextToSystemClipboard(json);
  } catch (error: any) {
    PREFER_APP_CLIPBOARD = true;
    console.error(error);
  }
};

const getAppClipboard = (): Partial<ElementsClipboard> => {
  if (!CLIPBOARD) {
    return {};
  }

  try {
    return JSON.parse(CLIPBOARD);
  } catch (error: any) {
    console.error(error);
    return {};
  }
};

const parsePotentialSpreadsheet = (
  text: string,
): { spreadsheet: Spreadsheet } | { errorMessage: string } | null => {
  const result = tryParseSpreadsheet(text);
  if (result.type === VALID_SPREADSHEET) {
    return { spreadsheet: result.spreadsheet };
  }
  return null;
};

/** internal, specific to parsing paste events. Do not reuse. */
function parseHTMLTree(el: ChildNode) {
  let result: PastedMixedContent = [];
  for (const node of el.childNodes) {
    if (node.nodeType === 3) {
      const text = node.textContent?.trim();
      if (text) {
        result.push({ type: "text", value: text });
      }
    } else if (node instanceof HTMLImageElement) {
      const url = node.getAttribute("src");
      if (url && url.startsWith("http")) {
        result.push({ type: "imageUrl", value: url });
      }
    } else {
      result = result.concat(parseHTMLTree(node));
    }
  }
  return result;
}

const maybeParseHTMLPaste = (event: ClipboardEvent) => {
  const html = event.clipboardData?.getData("text/html");

  if (!html) {
    return null;
  }

  try {
    const doc = new DOMParser().parseFromString(html, "text/html");

    const content = parseHTMLTree(doc.body);

    if (content.length) {
      return content;
    }
  } catch (error: any) {
    console.error(`error in parseHTMLFromPaste: ${error.message}`);
  }

  return null;
};

/**
 * Retrieves content from system clipboard (either from ClipboardEvent or
 *  via async clipboard API if supported)
 */
const getSystemClipboard = async (
  event: ClipboardEvent | null,
  isPlainPaste = false,
): Promise<
  | { type: "text"; value: string }
  | { type: "mixedContent"; value: PastedMixedContent }
> => {
  try {
    const mixedContent = !isPlainPaste && event && maybeParseHTMLPaste(event);
    if (mixedContent) {
      return { type: "mixedContent", value: mixedContent };
    }

    const text = event
      ? event.clipboardData?.getData("text/plain")
      : probablySupportsClipboardReadText &&
        (await navigator.clipboard.readText());

    return { type: "text", value: (text || "").trim() };
  } catch {
    return { type: "text", value: "" };
  }
};

/**
 * Attempts to parse clipboard. Prefers system clipboard.
 */
export const parseClipboard = async (
  event: ClipboardEvent | null,
  isPlainPaste = false,
): Promise<ClipboardData> => {
  const systemClipboard = await getSystemClipboard(event, isPlainPaste);

  if (systemClipboard.type === "mixedContent") {
    return {
      mixedContent: systemClipboard.value,
    };
  }

  // if system clipboard empty, couldn't be resolved, or contains previously
  // copied excalidraw scene as SVG, fall back to previously copied excalidraw
  // elements
  if (
    !systemClipboard ||
    (!isPlainPaste && systemClipboard.value.includes(SVG_EXPORT_TAG))
  ) {
    return getAppClipboard();
  }

  // if system clipboard contains spreadsheet, use it even though it's
  // technically possible it's staler than in-app clipboard
  const spreadsheetResult =
    !isPlainPaste && parsePotentialSpreadsheet(systemClipboard.value);

  if (spreadsheetResult) {
    return spreadsheetResult;
  }

  const appClipboardData = getAppClipboard();

  try {
    const systemClipboardData = JSON.parse(systemClipboard.value);
    const programmaticAPI =
      systemClipboardData.type === EXPORT_DATA_TYPES.excalidrawClipboardWithAPI;
    if (clipboardContainsElements(systemClipboardData)) {
      return {
        elements: systemClipboardData.elements,
        files: systemClipboardData.files,
        text: isPlainPaste
          ? JSON.stringify(systemClipboardData.elements, null, 2)
          : undefined,
        programmaticAPI,
      };
    }
  } catch (e) {}
  // system clipboard doesn't contain excalidraw elements → return plaintext
  // unless we set a flag to prefer in-app clipboard because browser didn't
  // support storing to system clipboard on copy
  return PREFER_APP_CLIPBOARD && appClipboardData.elements
    ? {
        ...appClipboardData,
        text: isPlainPaste
          ? JSON.stringify(appClipboardData.elements, null, 2)
          : undefined,
      }
    : { text: systemClipboard.value };
};

export const copyBlobToClipboardAsPng = async (blob: Blob | Promise<Blob>) => {
  try {
    // in Safari so far we need to construct the ClipboardItem synchronously
    // (i.e. in the same tick) otherwise browser will complain for lack of
    // user intent. Using a Promise ClipboardItem constructor solves this.
    // https://bugs.webkit.org/show_bug.cgi?id=222262
    //
    // Note that Firefox (and potentially others) seems to support Promise
    // ClipboardItem constructor, but throws on an unrelated MIME type error.
    // So we need to await this and fallback to awaiting the blob if applicable.
    await navigator.clipboard.write([
      new window.ClipboardItem({
        [MIME_TYPES.png]: blob,
      }),
    ]);
  } catch (error: any) {
    // if we're using a Promise ClipboardItem, let's try constructing
    // with resolution value instead
    if (isPromiseLike(blob)) {
      await navigator.clipboard.write([
        new window.ClipboardItem({
          [MIME_TYPES.png]: await blob,
        }),
      ]);
    } else {
      throw error;
    }
  }
};

export const copyTextToSystemClipboard = async (text: string | null) => {
  let copied = false;
  if (probablySupportsClipboardWriteText) {
    try {
      // NOTE: doesn't work on FF on non-HTTPS domains, or when document
      // not focused
      await navigator.clipboard.writeText(text || "");
      copied = true;
    } catch (error: any) {
      console.error(error);
    }
  }

  // Note that execCommand doesn't allow copying empty strings, so if we're
  // clearing clipboard using this API, we must copy at least an empty char
  if (!copied && !copyTextViaExecCommand(text || " ")) {
    throw new Error("couldn't copy");
  }
};

// adapted from https://github.com/zenorocha/clipboard.js/blob/ce79f170aa655c408b6aab33c9472e8e4fa52e19/src/clipboard-action.js#L48
const copyTextViaExecCommand = (text: string) => {
  const isRTL = document.documentElement.getAttribute("dir") === "rtl";

  const textarea = document.createElement("textarea");

  textarea.style.border = "0";
  textarea.style.padding = "0";
  textarea.style.margin = "0";
  textarea.style.position = "absolute";
  textarea.style[isRTL ? "right" : "left"] = "-9999px";
  const yPosition = window.pageYOffset || document.documentElement.scrollTop;
  textarea.style.top = `${yPosition}px`;
  // Prevent zooming on iOS
  textarea.style.fontSize = "12pt";

  textarea.setAttribute("readonly", "");
  textarea.value = text;

  document.body.appendChild(textarea);

  let success = false;

  try {
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);

    success = document.execCommand("copy");
  } catch (error: any) {
    console.error(error);
  }

  textarea.remove();

  return success;
};
