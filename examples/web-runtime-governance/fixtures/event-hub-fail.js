const { CustomEvent, window } = globalThis;

window.dispatchEvent(new CustomEvent("orders.updated"));