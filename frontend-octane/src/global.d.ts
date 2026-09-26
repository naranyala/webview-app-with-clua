interface Window {
  summarize?: (values: number[]) => Promise<Record<string, unknown>>;
  openPdf?: () => Promise<Record<string, unknown>>;
  extractPdfToc?: () => Promise<Record<string, unknown>>;
  __webview__?: {
    call: (
      name: string,
      ...args: unknown[]
    ) => Promise<Record<string, unknown>>;
  };
}
