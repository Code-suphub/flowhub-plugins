//! Per-query cookie jar. Never serialize this type into RPC results or logs.
use reqwest::{cookie::{CookieStore, Jar}, header::{HeaderMap, HeaderValue, SET_COOKIE}, Url};
use std::collections::BTreeMap;

pub(super) const EXPIRED: &str = "zgoCloud 认证已过期，请重新从浏览器复制 Cookie 和 XSRF Token";
const SESSION: &str = "virtfusion_session";
const XSRF: &str = "XSRF-TOKEN";

// No Debug/Serialize: renewal credentials must stay out of diagnostics and RPCs.
pub(super) struct Renewal {
    pub cookie: String,
    pub xsrf_token: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn url() -> Url { Url::parse("https://server.zgocloud.cc/server/123/resource/").unwrap() }
    fn initial() -> Session { Session::new("other=keep; virtfusion_session=old; XSRF-TOKEN=old%3D", "old=", &url()).unwrap() }
    fn headers(values: &[&str]) -> HeaderMap {
        let mut headers=HeaderMap::new();
        for value in values {headers.append(SET_COOKIE,HeaderValue::from_str(value).unwrap());}
        headers
    }
    #[test]
    fn rotates_auth_preserves_other_cookies_and_decodes_csrf_without_changing_plus() {
        let mut session=initial();
        session.accept(&headers(&[
            "virtfusion_session=new%3D; Path=/; Max-Age=7200; Secure; HttpOnly; SameSite=Lax",
            "XSRF-TOKEN=new%2Btoken%3D; Path=/; Max-Age=7200; Secure",
            "other=unexpected; Path=/",
        ]),&url());
        let renewed=session.renewal(&url()).unwrap();
        assert_eq!(pairs(&renewed.cookie).get(SESSION).unwrap(),"new%3D");
        assert_eq!(pairs(&renewed.cookie).get("other").unwrap(),"keep");
        assert_eq!(renewed.xsrf_token,"new+token=");
        let restored=Session::new(&renewed.cookie,&renewed.xsrf_token,&url()).unwrap();
        assert_eq!(restored.headers(&url()).unwrap().1,"new+token=");
        assert!(restored.renewal(&url()).is_none());
    }
    #[test]
    fn rejects_foreign_scopes_and_honours_deletion_and_expiry() {
        let mut session=initial();
        session.accept(&headers(&[
            "virtfusion_session=foreign; Domain=example.org; Path=/",
            "XSRF-TOKEN=foreign; Path=/admin",
            "unrelated=ignored; Path=/",
            "not-a-cookie",
        ]),&url());
        assert!(session.renewal(&url()).is_none());
        assert_eq!(session.headers(&url()).unwrap().1,"old=");
        for deletion in ["virtfusion_session=; Path=/; Max-Age=0", "virtfusion_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT", "XSRF-TOKEN=; Path=/; Max-Age=-1"] {
            let mut session=initial();session.accept(&headers(&[deletion]),&url());
            assert!(session.headers(&url()).is_err());
            let renewed=session.renewal(&url()).unwrap();assert!(renewed.cookie.is_empty());assert!(renewed.xsrf_token.is_empty());
        }
    }
    #[test]
    fn keeps_separate_csrf_until_server_rotates_it_and_rejects_control_bytes() {
        let mut session=Session::new("virtfusion_session=old", "fallback", &url()).unwrap();
        session.accept(&headers(&["virtfusion_session=new; Path=/"]),&url());
        assert_eq!(session.headers(&url()).unwrap().1,"fallback");
        session.accept(&headers(&["XSRF-TOKEN=bad%0D%0Aheader; Path=/"]),&url());
        assert!(session.headers(&url()).is_err());
        assert!(Session::new("virtfusion_session=", "x", &url()).is_err());
    }
}

pub(super) struct Session {
    jar: Jar,
    xsrf_fallback: String,
    xsrf_updated: bool,
    renewed: bool,
}

fn pairs(header: &str) -> BTreeMap<String, String> {
    header.split(';').filter_map(|part| {
        let (name, value) = part.trim().split_once('=')?;
        Some((name.to_owned(), value.to_owned()))
    }).collect()
}

impl Session {
    pub fn new(cookie: &str, xsrf: &str, url: &Url) -> Result<Self, String> {
        let jar = Jar::default();
        // Seed at / so cookies without attributes apply to both resource URLs.
        for (name, value) in pairs(cookie) {
            jar.add_cookie_str(&format!("{name}={value}; Path=/"), url);
        }
        let session = Self { jar, xsrf_fallback: xsrf.into(), xsrf_updated: false, renewed: false };
        session.headers(url)?;
        Ok(session)
    }

    pub fn headers(&self, url: &Url) -> Result<(String, String), String> {
        let raw = self.jar.cookies(url).and_then(|h| h.to_str().ok().map(str::to_owned)).unwrap_or_default();
        let values = pairs(&raw);
        if !values.get(SESSION).is_some_and(|s| !s.is_empty()) { return Err(EXPIRED.into()); }
        let xsrf = match values.get(XSRF) {
            Some(value) => {
                // form_urlencoded handles percent decoding; '+' in a cookie is literal.
                let encoded = format!("v={}", value.replace('+', "%2B"));
                url::form_urlencoded::parse(encoded.as_bytes()).next().map(|(_, v)| v.into_owned()).unwrap_or_default()
            },
            None if !self.xsrf_updated => self.xsrf_fallback.clone(),
            None => String::new(),
        };
        let cookie = values.into_iter().map(|(k,v)| format!("{k}={v}")).collect::<Vec<_>>().join("; ");
        if xsrf.is_empty() || cookie.len() + xsrf.len() > 12_000 || HeaderValue::from_str(&cookie).is_err() || HeaderValue::from_str(&xsrf).is_err() {
            return Err(EXPIRED.into());
        }
        Ok((cookie, xsrf))
    }

    // Called only after HTTP success and success=true JSON. CookieStore validates
    // domain, path, expiry and Max-Age, including deletion, without hand parsing.
    pub fn accept(&mut self, headers: &HeaderMap, url: &Url) {
        for header in headers.get_all(SET_COOKIE) {
            let Ok(text) = header.to_str() else { continue; };
            if text.len() > 8192 { continue; }
            let Some((name, _)) = text.split(';').next().and_then(|p| p.split_once('=')) else { continue; };
            let name = name.trim();
            if !matches!(name, SESSION | XSRF) { continue; }
            let before = self.jar.cookies(url);
            self.jar.set_cookies(&mut std::iter::once(header), url);
            if self.jar.cookies(url) != before {
                self.xsrf_updated |= name == XSRF;
                self.renewed = true;
            }
        }
    }

    pub fn renewal(&self, url: &Url) -> Option<Renewal> {
        if !self.renewed { return None; }
        match self.headers(url) {
            Ok((cookie, xsrf_token)) => Some(Renewal {cookie, xsrf_token}),
            // A successful response explicitly invalidated auth. Persist clearing
            // rather than resurrecting an old session on the next query.
            Err(_) => Some(Renewal {cookie:String::new(), xsrf_token:String::new()}),
        }
    }
}
