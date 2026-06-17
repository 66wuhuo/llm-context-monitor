// ============================================================
// CertManager — CA + per-host TLS certificate management
// Uses openssl CLI for reliable X.509 generation.
// ============================================================

import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export interface PemPair {
  cert: string;
  key: string;
}

/** Minimal openssl.cnf content for certificate generation.
 *  Some openssl installations (e.g. conda) have OPENSSLDIR pointing to a
 *  non-existent Windows path (C:\Program Files\Common Files\ssl).
 *  We supply a minimal inline config so `openssl req` always works. */
const MINIMAL_OPENSSL_CNF = `
[ req ]
distinguished_name = req_distinguished_name
prompt             = no
x509_extensions    = v3_ca

[ req_distinguished_name ]

[ v3_ca ]
basicConstraints       = critical, CA:TRUE
keyUsage               = critical, keyCertSign, cRLSign
subjectKeyIdentifier   = hash
authorityKeyIdentifier = keyid:always,issuer

[ v3_host ]
basicConstraints       = critical, CA:FALSE
keyUsage               = critical, digitalSignature, keyEncipherment
extendedKeyUsage       = serverAuth
subjectKeyIdentifier   = hash
authorityKeyIdentifier = keyid:always,issuer
`.trim();

export class CertManager {
  private caCert: PemPair | null = null;
  private hostCertCache = new Map<string, PemPair>();
  private minConfigPath: string | null = null;

  /** Check if openssl is available on this system */
  static isAvailable(): boolean {
    try {
      execSync('openssl version', { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /** Ensure the minimal openssl.cnf temp file exists and return its path.
   *  We create one temp config per CertManager instance — the file is tiny
   *  and shared across all openssl calls. */
  private ensureMinConfig(): string {
    if (this.minConfigPath && existsSync(this.minConfigPath)) {
      return this.minConfigPath;
    }
    const tmpDir = mkdtempSync(join(tmpdir(), 'llm-ssl-'));
    const cfgPath = join(tmpDir, 'openssl.cnf');
    writeFileSync(cfgPath, MINIMAL_OPENSSL_CNF);
    this.minConfigPath = cfgPath;
    return cfgPath;
  }

  /** Return the `-config <path>` CLI fragment pointing to our minimal config.
   *  We put the config path on the command line so it works even when the
   *  system openssl has a broken compiled-in OPENSSLDIR. */
  private configArg(): string {
    return `-config "${this.ensureMinConfig()}"`;
  }

  /** Set a previously persisted CA cert (call before getHostCert if restoring) */
  setCACert(pair: PemPair): void {
    this.caCert = pair;
  }

  /** Get or generate the CA certificate */
  getCACert(): PemPair {
    if (!this.caCert) {
      this.caCert = this.generateCACert();
    }
    return this.caCert;
  }

  /** Get or generate a TLS certificate for a hostname, signed by the CA */
  getHostCert(hostname: string): PemPair {
    const cached = this.hostCertCache.get(hostname);
    if (cached) return cached;

    const pair = this.generateHostCert(hostname);
    this.hostCertCache.set(hostname, pair);
    return pair;
  }

  /** Clear the host certificate cache */
  clearHostCache(): void {
    this.hostCertCache.clear();
  }

  // ---- Internal ----

  private generateCACert(): PemPair {
    const tmpDir = mkdtempSync(join(tmpdir(), 'llm-ca-'));
    try {
      const keyFile = join(tmpDir, 'ca.key');
      const certFile = join(tmpDir, 'ca.crt');
      const cfg = this.configArg();

      execSync(
        `openssl req -x509 ${cfg} -newkey rsa:2048 -nodes ` +
        `-keyout "${keyFile}" -out "${certFile}" ` +
        `-days 3650 -subj "/CN=LLM Context Monitor CA/O=LLM Monitor" ` +
        `-extensions v3_ca`,
        { timeout: 15000, stdio: 'pipe' }
      );

      return {
        key: readFileSync(keyFile, 'utf-8'),
        cert: readFileSync(certFile, 'utf-8'),
      };
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  private generateHostCert(hostname: string): PemPair {
    const tmpDir = mkdtempSync(join(tmpdir(), 'llm-host-'));
    try {
      const hostKeyFile = join(tmpDir, 'host.key');
      const hostCsrFile = join(tmpDir, 'host.csr');
      const hostCertFile = join(tmpDir, 'host.crt');
      const cfg = this.configArg();

      // Generate host key + CSR
      execSync(
        `openssl req ${cfg} -new -newkey rsa:2048 -nodes ` +
        `-keyout "${hostKeyFile}" -out "${hostCsrFile}" ` +
        `-subj "/CN=${hostname}"`,
        { timeout: 10000, stdio: 'pipe' }
      );

      // Sign with CA
      const ca = this.getCACert();
      const caKeyFile = join(tmpDir, 'ca.key');
      const caCertFile = join(tmpDir, 'ca.crt');
      writeFileSync(caKeyFile, ca.key);
      writeFileSync(caCertFile, ca.cert);

      execSync(
        `openssl x509 -req -in "${hostCsrFile}" ` +
        `-CA "${caCertFile}" -CAkey "${caKeyFile}" ` +
        `-CAcreateserial -out "${hostCertFile}" -days 365 ` +
        `-extensions v3_host`,
        { timeout: 10000, stdio: 'pipe' }
      );

      return {
        key: readFileSync(hostKeyFile, 'utf-8'),
        cert: readFileSync(hostCertFile, 'utf-8'),
      };
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }
}
