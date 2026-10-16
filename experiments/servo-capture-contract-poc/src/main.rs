use std::{env, time::Duration};

use serde_json::json;
use servo_fetch::{FetchOptions, NetworkPolicy, fetch};

const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let allow_fixture_private = matches!(args.next().as_deref(), Some("--allow-fixture-private"));
    let url = args.next().ok_or("usage: servo-capture-contract-poc [--allow-fixture-private] URL EXPECTED_TEXT")?;
    let expected_text = args.next().ok_or("missing expected text")?;
    if args.next().is_some() {
        return Err("too many arguments".into());
    }

    // This binary is only used by the isolated synthetic fixture test. Production
    // integrations must retain Changd's stricter connection-time egress policy.
    if allow_fixture_private {
        servo_fetch::init(NetworkPolicy::PERMISSIVE)?;
    }

    // The upstream API returns one Page from this one fetch. It deliberately
    // requests the screenshot mode so the Page contains both rendered text and
    // PNG bytes from the same Servo page lifecycle.
    let page = fetch(
        &FetchOptions::screenshot(&url, false)
            .timeout(Duration::from_secs(10))
            .settle(Duration::from_millis(350)),
    )
    .await?;

    if !page.inner_text.contains(&expected_text) {
        return Err("expected rendered synthetic text was not present".into());
    }
    let png = page.screenshot_png().ok_or("screenshot mode returned no PNG")?;
    let (width, height) = png_dimensions(png)?;
    if width == 0 || height == 0 {
        return Err("PNG dimensions must be non-zero".into());
    }

    // Do not print page text, URLs, or screenshots: real Changd values may be
    // private. The machine-readable result exposes only bounded synthetic facts.
    println!(
        "{}",
        json!({
            "sameSession": true,
            "textMatched": true,
            "png": { "valid": true, "width": width, "height": height, "bytes": png.len() },
            "capabilityLimits": {
                "httpStatus": "not exposed by servo-fetch 0.15.1 Page",
                "cssOrXPathGeometry": "not exposed by servo-fetch 0.15.1 public API",
                "browserSteps": "not exposed by servo-fetch 0.15.1 FetchOptions",
                "proxyTransport": "not exposed by servo-fetch 0.15.1 public API"
            }
        })
    );
    Ok(())
}

fn png_dimensions(png: &[u8]) -> Result<(u32, u32), Box<dyn std::error::Error>> {
    if png.len() < 24 || &png[..8] != PNG_SIGNATURE || &png[12..16] != b"IHDR" {
        return Err("invalid PNG signature or IHDR".into());
    }
    let width = u32::from_be_bytes(png[16..20].try_into()?);
    let height = u32::from_be_bytes(png[20..24].try_into()?);
    Ok((width, height))
}
