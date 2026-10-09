import assert from "node:assert/strict";

// Test-only Docker Hub mirror. Derive names/digests from the production definitions
// so updating a dependency cannot silently leave the harness on a different image.
export function testImage(image) {
  assert.match(image, /^[^\s@]+@sha256:[a-f0-9]{64}$/, "imagem de teste precisa de digest");
  const [name, digest] = image.split("@");
  let path = name;
  if (path.startsWith("docker.io/")) path = path.slice("docker.io/".length);
  else if (path.includes("/") && /[.:]|^localhost$/.test(path.split("/")[0])) return image;
  if (!path.includes("/")) path = `library/${path}`;
  return `mirror.gcr.io/${path}@${digest}`;
}

export function testImageOverlay(services, proxyDockerfile, probeDockerfile) {
  const imageFrom = (source, key) => {
    const image = source.match(new RegExp(`^ARG ${key}=(\\S+)$`, "m"))?.[1];
    assert.ok(image, `imagem base ${key} ausente`);
    return testImage(image);
  };
  return {
    services: {
      ...Object.fromEntries(
        Object.entries(services).map(([name, service]) => [
          name,
          { image: testImage(service.image) },
        ]),
      ),
      proxy: { build: { args: { CADDY_IMAGE: imageFrom(proxyDockerfile, "CADDY_IMAGE") } } },
      probe: { build: { args: { NODE_IMAGE: imageFrom(probeDockerfile, "NODE_IMAGE") } } },
    },
  };
}
