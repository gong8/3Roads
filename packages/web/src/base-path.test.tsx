// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("configurable deployment base path", () => {
	beforeEach(() => {
		document.body.innerHTML = '<div id="root"></div>';
		window.history.replaceState(null, "", "/3roads/");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify([]), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.resetModules();
	});

	it("renders a nested route and prefixes API and WebSocket URLs", async () => {
		const socketUrls: string[] = [];
		class FakeWebSocket {
			static readonly OPEN = 1;
			readonly readyState = FakeWebSocket.OPEN;
			onopen: (() => void) | null = null;
			onerror: ((event: Event) => void) | null = null;
			onmessage: ((event: MessageEvent) => void) | null = null;
			onclose: (() => void) | null = null;

			constructor(url: string | URL) {
				socketUrls.push(String(url));
			}

			send() {}
			close() {}
		}
		vi.stubGlobal("WebSocket", FakeWebSocket);

		await import("./main");
		await vi.waitFor(() => {
			expect(document.querySelector("#root")?.textContent).toContain("no sets yet");
		});

		const playLink = Array.from(document.querySelectorAll("a"))
			.find((link) => link.textContent === "play");
		expect(playLink?.getAttribute("href")).toBe("/3roads/play");
		playLink?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		await vi.waitFor(() => {
			expect(document.querySelector("#root")?.textContent).toContain("create room");
		});

		const requestedUrls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
		expect(requestedUrls).toContain("/3roads/sets");

		const { createGameSocket } = await import("./lib/ws");
		createGameSocket();
		expect(socketUrls).toEqual(["ws://localhost:3000/3roads/ws"]);
	});
});
