import { expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { remoteDoctorHome } from "./remoteDoctor.ts";

it("never resolves the remote doctor home from an ambient T3CODE_HOME", () => {
  expect(remoteDoctorHome(Option.none(), { T3CODE_HOME: "/home/user/.t3" })).toBeUndefined();
  expect(
    remoteDoctorHome(Option.none(), { T3CODE_HOME: "/home/user/.t3", AKERU_HOME: "/srv/akeru" }),
  ).toBe("/srv/akeru");
  expect(
    remoteDoctorHome(Option.some("/explicit"), {
      T3CODE_HOME: "/home/user/.t3",
      AKERU_HOME: "/srv/akeru",
    }),
  ).toBe("/explicit");
});
