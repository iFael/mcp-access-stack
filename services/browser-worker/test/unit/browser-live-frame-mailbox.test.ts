import { describe, expect, it } from "@jest/globals";
import { BrowserLiveFrameMailbox, jpegFrameDimensions } from "../../services/browser-live-frame-mailbox.js";

describe("BrowserLiveFrameMailbox", () => {
  it("reads the encoded JPEG size rather than CDP viewport metadata", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 1, 104, 2, 128, 3, 1, 17, 0]);
    expect(jpegFrameDimensions(jpeg.toString("base64"))).toEqual({ width: 640, height: 360 });
    expect(jpegFrameDimensions("not-a-jpeg")).toBeNull();
  });

  it("returns only the newest frame and drops oversized frames", async () => {
    const mailbox = new BrowserLiveFrameMailbox({ maxFrameBytes: 8, minFrameIntervalMs: 0 });
    mailbox.publish({ data: "old", width: 800, height: 450 }, 100);
    mailbox.publish({ data: "new", width: 800, height: 450 }, 101);
    mailbox.publish({ data: "0123456789", width: 800, height: 450 }, 102);
    await expect(mailbox.read(0, 1)).resolves.toMatchObject({ seq: 2, data: "new" });
    await expect(mailbox.read(2, 1)).resolves.toBeNull();
  });

  it("wakes a waiting reader when a new frame arrives", async () => {
    const mailbox = new BrowserLiveFrameMailbox({ maxFrameBytes: 100, minFrameIntervalMs: 0 });
    const pending = mailbox.read(0, 100);
    mailbox.publish({ data: "frame", width: 640, height: 360 }, 200);
    await expect(pending).resolves.toMatchObject({ seq: 1, data: "frame" });
    mailbox.close();
    await expect(mailbox.read(1, 1)).resolves.toBeNull();
  });
});
