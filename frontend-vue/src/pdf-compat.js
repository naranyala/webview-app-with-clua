/*
 * Promise.withResolvers polyfill for older WebKit builds, which pdfjs-dist
 * assumes are present. pdf-session.js imports this first so it is in place
 * before a worker is created.
 */

if (!Promise.withResolvers) {
  Promise.withResolvers = function withResolvers() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  };
}
