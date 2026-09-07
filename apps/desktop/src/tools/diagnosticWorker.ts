import { decodeDiagnostic } from "./diagnosticParser";

self.onmessage = (event: MessageEvent<ArrayBuffer>) => {
  try { self.postMessage({ document: decodeDiagnostic(event.data) }); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : "无法解析诊断文件" }); }
};
