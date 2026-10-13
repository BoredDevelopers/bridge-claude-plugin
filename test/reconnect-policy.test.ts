/**
 * reconnect-policy.ts — what the person is told about a close. Pure. (Which close is
 * which class, and when to reconnect, are the SDK's — tested there.)
 */
import { UPDATE_HOWTO } from "../update-howto";
import { describe, test, expect } from "bun:test";
import { describeClose } from "../reconnect-policy";

describe("describeClose", () => {
  test("describeClose: superseded — a NEWER holder says update; equal/older/unknown says take it back", () => {
    // RFC-017 D3/finding 6: the wording must not claim "a newer plugin" took over unless
    // the holder's OWN version really is newer than this process's — a person's explicit
    // `/einweave:connect takeover` from an equal or older window is a plain takeover, not an
    // update prompt.
    const newer = describeClose("superseded", 4008, "session superseded: …", {
      supersededBy: { pid: 4242, version: "0.27.0", tty: "ttys003", termProgram: "iTerm.app", cwd: "/Users/j/Code/x" },
      myVersion: "0.26.0",
    });
    expect(newer).toContain("pid 4242");
    expect(newer).toContain("0.27.0");
    expect(newer).toContain("ttys003");
    expect(newer).toContain("iTerm.app");
    expect(newer).toContain("/Users/j/Code/x");
    expect(newer).toContain("/reload-plugins");
    expect(newer).toContain("/einweave:connect takeover");

    const equal = describeClose("superseded", 4008, "session superseded: …", {
      supersededBy: { pid: 4242, version: "0.26.0" },
      myVersion: "0.26.0",
    });
    expect(equal).not.toContain("/reload-plugins");
    expect(equal).toContain("took over Bridge");
    expect(equal).toContain("/einweave:connect takeover");

    const older = describeClose("superseded", 4008, "session superseded: …", {
      supersededBy: { pid: 4242, version: "0.20.0" },
      myVersion: "0.26.0",
    });
    expect(older).not.toContain("/reload-plugins");

    const unknown = describeClose("superseded", 4008, "session superseded: …", {
      supersededBy: { pid: 4242 },
      myVersion: "0.26.0",
    });
    expect(unknown).not.toContain("/reload-plugins");
    expect(unknown).toContain("pid 4242");

    const anonymous = describeClose("superseded", 4008, "session superseded: …");
    expect(anonymous).toContain("another window");
    expect(anonymous).toContain("/einweave:connect takeover");
    expect(anonymous).not.toContain("/reload-plugins");
  });

  test("describeClose: too-old always says the update instruction", () => {
    const text = describeClose("too-old", 4008, "client too old: open /plugin → Installed → einweave → Update now, then /reload-plugins");
    expect(text).toContain(UPDATE_HOWTO);
    expect(text).toContain("/reload-plugins");
  });
  test("4008 says what to do, by reason", () => {
    expect(describeClose("revoked", 4008, "session revoked")).toContain("/einweave:connect starts a new session");
    expect(describeClose("revoked", 4008, "installation revoked")).toContain("run /einweave:login");
    // RFC-016 E8: a lock is a copy detected — say so, and how to recover.
    const locked = describeClose("revoked", 4008, "installation locked");
    expect(locked).toContain("credential copy detected");
    expect(locked).toContain("LOCKED");
    expect(locked).toContain("check this machine");
    expect(locked).toContain("/einweave:login");
    // S4: "deleted here" only when this process deleted it.
    expect(locked).not.toContain("deleted");
    const deleted = describeClose("revoked", 4008, "installation locked", { keyDeleted: true });
    expect(deleted).toContain("its key was deleted here");
    expect(deleted).toContain("/einweave:login");
  });

  test("4001 points at /einweave:login — never the retired /einweave:configure token", () => {
    const t = describeClose("credential", 4001, "Invalid token");
    expect(t).toContain("/einweave:login");
    expect(t).not.toContain("/einweave:configure");
    expect(describeClose("credential", 4003, undefined)).not.toContain("/einweave:configure");
  });

  test("session-in-use (RFC-027: the grant is held by another live socket) says how to move it here", () => {
    const t = describeClose("session-in-use", 4008, "session already connected");
    expect(t).toContain("/einweave:connect takeover");
    expect(t).toContain("already connected");
  });
});
