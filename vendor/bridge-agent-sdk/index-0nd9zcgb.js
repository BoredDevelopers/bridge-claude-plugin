// src/runtime/async-channel.ts
class AsyncChannel {
  maxSize;
  buf = [];
  waiting = [];
  ended = false;
  constructor(maxSize = 0) {
    this.maxSize = maxSize;
  }
  push(item) {
    if (this.ended)
      return;
    if (this.waiting.length > 0) {
      this.waiting.shift()({ value: item, done: false });
      return;
    }
    this.buf.push(item);
    if (this.maxSize > 0 && this.buf.length > this.maxSize)
      return this.buf.shift();
    return;
  }
  end() {
    if (this.ended)
      return;
    this.ended = true;
    for (const resolve of this.waiting.splice(0))
      resolve({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.buf.length > 0)
          return Promise.resolve({ value: this.buf.shift(), done: false });
        if (this.ended)
          return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiting.push(resolve));
      }
    };
  }
}

export { AsyncChannel };
