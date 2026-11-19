type Task = () => void;

let post: ((task: Task) => void) | undefined;

function channel() {
  const queue: Task[] = [];
  const { port1, port2 } = new MessageChannel();
  port1.onmessage = () => queue.shift()?.();
  return (task: Task) => {
    queue.push(task);
    port2.postMessage(0);
  };
}

/**
 * JSZip yields between chunks with `setImmediate`, which browsers and mobile
 * don't have. The build points JSZip's calls here instead of bundling its
 * polyfill, which adds script elements to the page on old browsers.
 */
export function setImmediate<A extends unknown[]>(callback: (...args: A) => void, ...args: A) {
  post ??= channel();
  post(() => callback(...args));
}
