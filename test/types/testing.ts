import { ReleaseWorkflow } from "../../src/index.js";
import { ReleaseTestProject, TestPublisher, TestReleaseHost } from "../../src/testing.js";
import type { PackagePublisher, ReleaseHost } from "../../src/index.js";

export async function testingContracts() {
  const project = await ReleaseTestProject.create();
  project.publisher satisfies PackagePublisher;
  project.host satisfies ReleaseHost;
  const workflow = new ReleaseWorkflow(project.services);
  await project.copyFiles(".");
  await project.copyFiles(".", []);
  await project.copyFiles(".", "**/*.{js,md}");
  await project.copyFiles(".", "README.md");
  await project.copyFiles(".", ["README.md"] as const);
  await project.write("nested/file.txt", "Fixture.");
  await workflow.prepare({ ...project.options, version: "0.2.0" });
  await project.dispose();
  // @ts-expect-error File selections must be glob strings or arrays.
  await project.copyFiles(".", 123);
  // @ts-expect-error Omit the list for recursion rather than passing null.
  await project.copyFiles(".", null);
  // @ts-expect-error Temporary projects can only be created by the owning factory.
  new ReleaseTestProject(".");
  new TestPublisher(".", { failure: "Rejected" });
  new TestReleaseHost(".", { failure: "Rejected" });
}
