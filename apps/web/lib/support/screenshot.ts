/**
 * Automatic capture of the page for a technical report (docs/22 §5.1), with the maintained
 * `modern-screenshot` library, loaded only when someone reports. Password fields are blanked and
 * anything marked `data-feedback-ignore` (the «تواصل معنا» button and its dialogs) is left out.
 * Null when the browser cannot capture: the dialog then offers an upload instead.
 */
export async function capturePage(): Promise<Blob | null> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  try {
    const { domToBlob } = await import('modern-screenshot');
    const blob = await domToBlob(document.body, {
      type: 'image/png',
      scale: Math.min(window.devicePixelRatio || 1, 2),
      width: window.innerWidth,
      backgroundColor: '#ffffff',
      filter: (node) => !(node instanceof Element && node.hasAttribute('data-feedback-ignore')),
      onCloneNode: (clone) => {
        if (clone instanceof Element) {
          clone.querySelectorAll('input[type="password"]').forEach((el) => {
            (el as HTMLInputElement).value = '';
            el.setAttribute('value', '');
          });
        }
      },
      timeout: 8000,
    });
    // The server takes at most 5 MB per image.
    return blob && blob.size > 0 && blob.size < 5 * 1024 * 1024 ? blob : null;
  } catch {
    return null;
  }
}
