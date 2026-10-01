# Security policy

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub: **Security tab > Report a vulnerability** on this repository. If you cannot use that, contact your HG Insights representative.

We aim to acknowledge a report within 3 business days.

## Supported versions

Only the latest release receives fixes.

## Verifying a release

Every release publishes `SHA256SUMS`, a CycloneDX SBOM, and signed build-provenance attestations; the npm package is published with provenance.

```bash
sha256sum -c SHA256SUMS --ignore-missing                 # shasum -a 256 -c on macOS
gh attestation verify hgi-vX.Y.Z-<os>-<arch>.tar.gz --repo HGInsights/hgi-cli
npm view @hginsights/hgi dist.attestations                # provenance of the npm package
# in a project that depends on @hginsights/hgi: npm audit signatures
```

The security model of the tool itself is in [docs/security.md](docs/security.md).
