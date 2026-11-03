// UDP listeners for scoreboard feeds (ARCHITECTURE.md §11). A Lantronix box in
// UDP mode sends the console's bytes as datagrams to one host or to the subnet
// broadcast address. The server listens on that port on every IPv4 interface
// (on Linux a socket bound to an address never sees broadcasts) and hands each
// datagram to whoever listens for its source IP.
//
// One socket per port, shared by every feed and "Test connection" on it, so a
// test never binds a port twice or disturbs a feed. Receive only: a datagram
// sent to the box goes out its serial port into the console, and a box set to
// Remote IP 0.0.0.0 would start sending to whoever wrote last instead of to
// Daktronics' own PC. So no send(), connect() or setBroadcast(), ever.

import dgram from 'node:dgram';

export class UdpListeners {
  #createSocket;
  #ports = new Map(); // port -> { port, socket, bound, closed, subscribers: Map<source IP, Set>, watchers: Set }

  constructor({ createSocket = () => dgram.createSocket({ type: 'udp4' }) } = {}) {
    this.#createSocket = createSocket;
  }

  // Listens on `port` for datagrams from `source` (an IPv4 address). Handlers:
  // listening() once the port is bound; message(buffer) for each datagram from
  // `source`; other(ip), optional, for each datagram from anyone else; error(err)
  // when the port can't be bound or the socket fails - the subscription is over
  // then. Returns { close() }.
  subscribe(port, source, handlers) {
    const listener = this.#ports.get(port) ?? this.#open(port);
    const subscription = { source, handlers, active: true, close: () => this.#unsubscribe(listener, subscription) };
    let group = listener.subscribers.get(source);
    if (!group) listener.subscribers.set(source, (group = new Set()));
    group.add(subscription);
    if (handlers.other) listener.watchers.add(subscription);
    if (listener.bound) {
      queueMicrotask(() => {
        if (subscription.active) handlers.listening?.();
      });
    }
    return subscription;
  }

  // Closes every socket (the service is stopping). Nobody is told.
  closeAll() {
    for (const listener of [...this.#ports.values()]) {
      for (const subscription of subscriptionsOf(listener)) subscription.active = false;
      this.#close(listener);
    }
  }

  #open(port) {
    const socket = this.#createSocket();
    const listener = { port, socket, bound: false, closed: false, subscribers: new Map(), watchers: new Set() };
    this.#ports.set(port, listener);
    // The handlers stay attached after close, so late events are dropped
    // rather than thrown.
    socket.on('listening', () => {
      if (listener.closed) return;
      listener.bound = true;
      for (const subscription of subscriptionsOf(listener)) {
        if (subscription.active) subscription.handlers.listening?.();
      }
    });
    socket.on('message', (message, rinfo) => {
      if (listener.closed) return;
      const source = rinfo?.address;
      for (const subscription of [...(listener.subscribers.get(source) ?? [])]) {
        if (subscription.active) subscription.handlers.message(message);
      }
      for (const watcher of [...listener.watchers]) {
        if (watcher.active && watcher.source !== source) watcher.handlers.other(source);
      }
    });
    socket.on('error', (err) => this.#fail(listener, err));
    try {
      socket.bind(port);
    } catch (err) {
      queueMicrotask(() => this.#fail(listener, err));
    }
    return listener;
  }

  // The port couldn't be bound (or the socket failed): it is given up, and
  // every subscriber is told and retries on its own.
  #fail(listener, err) {
    if (listener.closed) return;
    const subscriptions = subscriptionsOf(listener);
    this.#close(listener);
    for (const subscription of subscriptions) {
      if (!subscription.active) continue;
      subscription.active = false;
      subscription.handlers.error?.(err);
    }
  }

  #unsubscribe(listener, subscription) {
    if (!subscription.active) return;
    subscription.active = false;
    const group = listener.subscribers.get(subscription.source);
    group?.delete(subscription);
    if (group?.size === 0) listener.subscribers.delete(subscription.source);
    listener.watchers.delete(subscription);
    if (listener.subscribers.size === 0) this.#close(listener);
  }

  #close(listener) {
    if (listener.closed) return;
    listener.closed = true;
    listener.bound = false;
    if (this.#ports.get(listener.port) === listener) this.#ports.delete(listener.port);
    try {
      listener.socket.close();
    } catch {
      // already closed
    }
  }
}

function subscriptionsOf(listener) {
  return [...listener.subscribers.values()].flatMap((group) => [...group]);
}
