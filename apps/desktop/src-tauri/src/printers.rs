//! The printers the system knows about, for choosing a thermal printer. Names only: sending to a
//! printer is the job of the print code (prompt 17); this lets the settings screen offer a list.

/// One name per line, blanks dropped, duplicates removed, order kept.
pub fn parse_lines(out: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    out.lines()
        .map(|l| l.trim().trim_start_matches('\u{feff}').to_string())
        .filter(|l| !l.is_empty())
        .filter(|l| seen.insert(l.clone()))
        .collect()
}

#[tauri::command(async)]
pub fn list_printers() -> Result<Vec<String>, String> {
    let output = if cfg!(windows) {
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", "Get-Printer | ForEach-Object { $_.Name }"])
            .output()
    } else {
        // CUPS: one printer name per line
        std::process::Command::new("lpstat").arg("-e").output()
    };
    match output {
        Ok(o) if o.status.success() => Ok(parse_lines(&String::from_utf8_lossy(&o.stdout))),
        // no CUPS or no print service is "no printers", not a failure the person can act on
        Ok(_) => Ok(vec![]),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(format!("cannot list printers: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_keeps_names_in_order_without_blanks_or_repeats() {
        let out = "\u{feff}Microsoft Print to PDF\r\n\r\nEPSON TM-T82  \r\nMicrosoft Print to PDF\r\n";
        assert_eq!(parse_lines(out), vec!["Microsoft Print to PDF", "EPSON TM-T82"]);
        assert!(parse_lines("").is_empty());
        assert_eq!(parse_lines("HP_LaserJet\nTM-T20"), vec!["HP_LaserJet", "TM-T20"]);
    }
}
