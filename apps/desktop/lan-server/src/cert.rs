//! The server's certificate: self-signed, made once and kept, remade when the addresses it must cover change.
//! A device pins its fingerprint when it pairs, so a certificate that changes for no reason is a warning sign
//! and one that changes because the computer got a new address is not.

use std::{fs, path::Path};

use rcgen::{CertificateParams, KeyPair};
use sha2::{Digest, Sha256};

use crate::LanError;

pub struct Identity {
    pub cert_pem: String,
    pub key_pem: String,
    /// SHA-256 of the certificate's DER, as `AB:CD:...`.
    pub fingerprint: String,
}

pub fn fingerprint_of(der: &[u8]) -> String {
    Sha256::digest(der)
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// Load the certificate in `dir`, or make one valid for `names` (host names and addresses).
pub fn load_or_create(dir: &Path, names: &[String]) -> Result<Identity, LanError> {
    fs::create_dir_all(dir)?;
    let cert_path = dir.join("lan-cert.pem");
    let key_path = dir.join("lan-key.pem");
    let sans_path = dir.join("lan-names.txt");
    let mut wanted: Vec<String> = names.to_vec();
    wanted.sort();
    wanted.dedup();
    let wanted_text = wanted.join("\n");

    if cert_path.exists()
        && key_path.exists()
        && fs::read_to_string(&sans_path).ok().as_deref() == Some(wanted_text.as_str())
    {
        let cert_pem = fs::read_to_string(&cert_path)?;
        let key_pem = fs::read_to_string(&key_path)?;
        if let Some(der) = pem_to_der(&cert_pem) {
            return Ok(Identity {
                fingerprint: fingerprint_of(&der),
                cert_pem,
                key_pem,
            });
        }
    }

    let key = KeyPair::generate().map_err(|e| LanError::Cert(e.to_string()))?;
    let params =
        CertificateParams::new(wanted.clone()).map_err(|e| LanError::Cert(e.to_string()))?;
    let cert = params
        .self_signed(&key)
        .map_err(|e| LanError::Cert(e.to_string()))?;
    let cert_pem = cert.pem();
    let key_pem = key.serialize_pem();
    fs::write(&cert_path, &cert_pem)?;
    write_private(&key_path, &key_pem)?;
    fs::write(&sans_path, wanted_text)?;
    Ok(Identity {
        fingerprint: fingerprint_of(cert.der()),
        cert_pem,
        key_pem,
    })
}

/// The key is readable by this user only.
fn write_private(path: &Path, text: &str) -> Result<(), LanError> {
    fs::write(path, text)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// The DER bytes of the first certificate in a PEM file, without a PEM library.
pub fn pem_to_der(pem: &str) -> Option<Vec<u8>> {
    let body: String = pem
        .lines()
        .skip_while(|l| !l.starts_with("-----BEGIN CERTIFICATE-----"))
        .skip(1)
        .take_while(|l| !l.starts_with("-----END"))
        .collect();
    decode_base64(&body)
}

fn decode_base64(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut buf, mut bits) = (0u32, 0u32);
    for c in s.bytes().filter(|c| !c.is_ascii_whitespace() && *c != b'=') {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Some(out)
}
