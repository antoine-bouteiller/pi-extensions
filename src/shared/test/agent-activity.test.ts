import { describe, expect, test } from "bun:test";
import { createAgentActivityStore, type RunningAgent } from "../agent-activity";

describe("agent activity store", () => {
  test("publishes a snapshot that later mutations cannot change", () => {
    const store = createAgentActivityStore();
    const published: RunningAgent[] = [{ name: "/scout", color: "accent" }];

    store.publish(published);
    published.push({ name: "/reviewer", color: "warning" });

    expect(store.list()).toEqual([{ name: "/scout", color: "accent" }]);
  });

  test("notifies subscribers until they unsubscribe", () => {
    const store = createAgentActivityStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => notifications++);

    store.publish([{ name: "/scout", color: "accent" }]);
    store.publish([]);
    unsubscribe();
    store.publish([{ name: "/scout", color: "accent" }]);

    expect(notifications).toBe(2);
    expect(store.list()).toEqual([{ name: "/scout", color: "accent" }]);
  });
});
