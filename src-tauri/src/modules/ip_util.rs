//! IP 地址工具：校验、CIDR（v4/v6）、规范化、分类、可信客户端地址提取。
//!
//! 所有函数都是无副作用纯函数，便于单元测试与热路径复用。

use axum::http::HeaderMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::str::FromStr;
use std::sync::OnceLock;

/// CIDR 网络（IPv4 或 IPv6）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IpNetwork {
    V4(Ipv4Network),
    V6(Ipv6Network),
}

/// IPv4 CIDR 网络，地址部分已按前缀清零主机位。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ipv4Network {
    addr: Ipv4Addr,
    prefix: u8,
}

/// IPv6 CIDR 网络，地址部分已按前缀清零主机位。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ipv6Network {
    addr: Ipv6Addr,
    prefix: u8,
}

impl Ipv4Network {
    /// 从地址与前缀构造网络，主机位自动清零。
    pub fn new(addr: Ipv4Addr, prefix: u8) -> Self {
        let bits = u32::from(addr);
        let masked = if prefix == 0 {
            0
        } else {
            bits & (u32::MAX << (32 - prefix))
        };
        Self {
            addr: Ipv4Addr::from(masked),
            prefix,
        }
    }

    /// 判断地址是否属于该网络。
    pub fn contains(&self, addr: Ipv4Addr) -> bool {
        let network = u32::from(self.addr);
        let candidate = u32::from(addr);
        if self.prefix == 0 {
            return true;
        }
        let mask = u32::MAX << (32 - self.prefix);
        (candidate & mask) == network
    }
}

impl Ipv6Network {
    /// 从地址与前缀构造网络，主机位自动清零。
    pub fn new(addr: Ipv6Addr, prefix: u8) -> Self {
        let bits = u128::from(addr);
        let masked = if prefix == 0 {
            0
        } else {
            bits & (u128::MAX << (128 - prefix))
        };
        Self {
            addr: Ipv6Addr::from(masked),
            prefix,
        }
    }

    /// 判断地址是否属于该网络。
    pub fn contains(&self, addr: Ipv6Addr) -> bool {
        let network = u128::from(self.addr);
        let candidate = u128::from(addr);
        if self.prefix == 0 {
            return true;
        }
        let mask = u128::MAX << (128 - self.prefix);
        (candidate & mask) == network
    }
}

impl IpNetwork {
    /// 解析 `ip/prefix` 形式的 CIDR，前缀越界或地址非法返回 None。
    pub fn parse(input: &str) -> Option<Self> {
        let (ip_part, prefix_part) = input.trim().split_once('/')?;
        let prefix: u8 = prefix_part.trim().parse().ok()?;
        match IpAddr::from_str(ip_part.trim()).ok()? {
            IpAddr::V4(addr) => {
                if prefix > 32 {
                    return None;
                }
                Some(IpNetwork::V4(Ipv4Network::new(addr, prefix)))
            }
            IpAddr::V6(addr) => {
                if prefix > 128 {
                    return None;
                }
                Some(IpNetwork::V6(Ipv6Network::new(addr, prefix)))
            }
        }
    }

    /// 判断任意版本地址是否属于该网络（版本不匹配为 false）。
    pub fn contains_ip(&self, ip: &IpAddr) -> bool {
        match (self, ip) {
            (IpNetwork::V4(net), IpAddr::V4(addr)) => net.contains(*addr),
            (IpNetwork::V6(net), IpAddr::V6(addr)) => net.contains(*addr),
            _ => false,
        }
    }

    /// 规范化输出（主机位清零后的标准写法）。
    pub fn to_normalized_string(&self) -> String {
        match self {
            IpNetwork::V4(net) => format!("{}/{}", net.addr, net.prefix),
            IpNetwork::V6(net) => format!("{}/{}", net.addr, net.prefix),
        }
    }
}

/// 校验名单规则：支持单个 IPv4/IPv6，或 IPv4/IPv6 CIDR。
pub fn is_valid_ip_pattern(pattern: &str) -> bool {
    let trimmed = pattern.trim();
    if trimmed.is_empty() || trimmed.contains(char::is_whitespace) {
        return false;
    }
    if trimmed.contains('/') {
        return IpNetwork::parse(trimmed).is_some();
    }
    IpAddr::from_str(trimmed).is_ok()
}

/// 把 IPv4-mapped IPv6（如 `::ffff:1.2.3.4`）还原为 IPv4，其余地址原样返回。
pub fn display_ip(ip: &str) -> String {
    match IpAddr::from_str(ip.trim()) {
        Ok(IpAddr::V6(v6)) => match v6.to_ipv4_mapped() {
            Some(v4) => v4.to_string(),
            None => v6.to_string(),
        },
        Ok(IpAddr::V4(v4)) => v4.to_string(),
        Err(_) => ip.trim().to_string(),
    }
}

/// 规范化名单规则：单 IP 解析后重写（去前导零、压缩 IPv6、v4-mapped 还原）；
/// CIDR 清零主机位。无法解析时返回 None。
pub fn normalize_pattern(pattern: &str) -> Option<String> {
    let trimmed = pattern.trim();
    if trimmed.contains('/') {
        let network = IpNetwork::parse(trimmed)?;
        Some(network.to_normalized_string())
    } else {
        let addr = IpAddr::from_str(trimmed).ok()?;
        Some(display_addr(addr).to_string())
    }
}

/// 解析日志/请求中出现的对端 IP，兼容 v4-mapped 写法。
pub fn parse_client_ip(ip: &str) -> Option<IpAddr> {
    let addr = IpAddr::from_str(ip.trim()).ok()?;
    Some(match addr {
        IpAddr::V6(v6) => v6
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(v6)),
        other => other,
    })
}

fn display_addr(addr: IpAddr) -> IpAddr {
    match addr {
        IpAddr::V6(v6) => v6
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(v6)),
        other => other,
    }
}

/// IP 的粗分类，用于本地标签与"是否需要在线归属地查询"判断。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IpClass {
    /// 本机回环（127.0.0.0/8、::1）
    Loopback,
    /// 私网/局域网（10/8、172.16/12、192.168/16、fc00::/7 等）
    Private,
    /// 链路本地（169.254/16、fe80::/10）
    LinkLocal,
    /// Cloudflare 官方公布的边缘网段
    Cloudflare,
    /// 公网 IP
    Public,
    /// 无法解析
    Unknown,
}

impl IpClass {
    /// 只有公网 IP 才需要发起在线 GeoIP 查询。
    pub fn needs_geoip(self) -> bool {
        matches!(self, IpClass::Public | IpClass::Cloudflare)
    }
}

/// 对 IP 字符串分类。
pub fn classify_ip(ip: &str) -> IpClass {
    let Some(addr) = parse_client_ip(ip) else {
        return IpClass::Unknown;
    };
    classify_addr(&addr)
}

fn classify_addr(addr: &IpAddr) -> IpClass {
    if is_loopback(addr) {
        return IpClass::Loopback;
    }
    if is_link_local(addr) {
        return IpClass::LinkLocal;
    }
    if is_private(addr) {
        return IpClass::Private;
    }
    if cloudflare_networks()
        .iter()
        .any(|network| network.contains_ip(addr))
    {
        return IpClass::Cloudflare;
    }
    IpClass::Public
}

/// 是否为本机回环地址（白名单模式下回环始终放行，防止自锁）。
pub fn is_loopback_ip(ip: &str) -> bool {
    parse_client_ip(ip)
        .map(|addr| is_loopback(&addr))
        .unwrap_or(false)
}

fn is_loopback(addr: &IpAddr) -> bool {
    match addr {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => v6.is_loopback(),
    }
}

fn is_link_local(addr: &IpAddr) -> bool {
    match addr {
        IpAddr::V4(v4) => v4.is_link_local(),
        IpAddr::V6(v6) => {
            const FE80: u16 = 0xfe80;
            v6.segments()[0] & 0xffc0 == FE80
        }
    }
}

fn is_private(addr: &IpAddr) -> bool {
    match addr {
        IpAddr::V4(v4) => v4.is_private(),
        IpAddr::V6(v6) => {
            // is_unique_local 覆盖 fc00::/7；IPv6 无私有概念但 ULA 等价
            v6.is_unique_local()
        }
    }
}

fn cloudflare_networks() -> &'static [IpNetwork] {
    static CLOUDFLARE: OnceLock<Vec<IpNetwork>> = OnceLock::new();
    CLOUDFLARE.get_or_init(|| {
        // 官方网段列表：https://www.cloudflare.com/ips/
        const V4: &[&str] = &[
            "173.245.48.0/20",
            "103.21.244.0/22",
            "103.22.200.0/22",
            "103.31.4.0/22",
            "141.101.64.0/18",
            "108.162.192.0/18",
            "190.93.240.0/20",
            "188.114.96.0/20",
            "197.234.240.0/22",
            "198.41.128.0/17",
            "162.158.0.0/15",
            "104.16.0.0/13",
            "104.24.0.0/14",
            "172.64.0.0/13",
            "131.0.72.0/22",
        ];
        const V6: &[&str] = &[
            "2400:cb00::/32",
            "2606:4700::/32",
            "2803:f800::/32",
            "2405:b500::/32",
            "2405:8100::/32",
            "2a06:98c0::/29",
            "2c0f:f248::/32",
        ];
        V4.iter()
            .chain(V6.iter())
            .filter_map(|cidr| IpNetwork::parse(cidr))
            .collect()
    })
}

/// 代理头信任模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustMode {
    /// 直连部署：只认 TCP 对端地址，忽略一切代理头（防伪造）。
    Direct,
    /// 前置可信代理（如 Nginx）：取 X-Forwarded-For 从右数第 hops 跳。
    ProxyHops(u8),
    /// Cloudflare 隧道：优先 CF-Connecting-IP，其次 XFF 最右一跳。
    Cloudflare,
}

/// 从请求头与 TCP 对端地址中挑选真实客户端 IP。
///
/// - Direct：永远返回 TCP 对端，客户端自带的 XFF/XRI 被忽略；
/// - ProxyHops(n)：XFF 从右向左第 n 个合法地址，退回 X-Real-IP、TCP 对端；
/// - Cloudflare：CF-Connecting-IP 优先（Cloudflare 保证其不可伪造），再 XFF 最右。
///
/// 所有头值都必须能解析为合法 IP，防止注入垃圾值。
pub fn pick_client_ip(
    headers: &HeaderMap,
    peer: Option<IpAddr>,
    mode: TrustMode,
) -> Option<String> {
    match mode {
        TrustMode::Direct => peer.map(|ip| display_ip(&ip.to_string())),
        TrustMode::Cloudflare => {
            if let Some(ip) = header_first_ip(headers, "cf-connecting-ip") {
                return Some(ip);
            }
            xff_from_right(headers, 1)
                .or_else(|| header_first_ip(headers, "x-real-ip"))
                .or_else(|| peer.map(|ip| display_ip(&ip.to_string())))
        }
        TrustMode::ProxyHops(hops) => {
            let hops = hops.max(1);
            xff_from_right(headers, hops)
                .or_else(|| header_first_ip(headers, "x-real-ip"))
                .or_else(|| peer.map(|ip| display_ip(&ip.to_string())))
        }
    }
}

fn header_first_ip(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)?
        .to_str()
        .ok()?
        .split(',')
        .next()?
        .trim()
        .parse::<IpAddr>()
        .ok()
        .map(|ip| display_ip(&ip.to_string()))
}

/// 取 X-Forwarded-For 从右数第 n 个合法 IP（n 从 1 开始）。
fn xff_from_right(headers: &HeaderMap, nth_from_right: u8) -> Option<String> {
    let raw = headers.get("x-forwarded-for")?.to_str().ok()?;
    let parsed: Vec<String> = raw
        .split(',')
        .map(str::trim)
        .filter_map(|part| part.parse::<IpAddr>().ok())
        .map(|ip| display_ip(&ip.to_string()))
        .collect();
    let index = parsed.len().checked_sub(nth_from_right as usize)?;
    parsed.get(index).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_ipv4_and_cidr() {
        assert!(is_valid_ip_pattern("192.168.1.1"));
        assert!(is_valid_ip_pattern("10.0.0.0/8"));
        assert!(is_valid_ip_pattern("0.0.0.0/0"));
        assert!(!is_valid_ip_pattern("192.168.1.999"));
        assert!(!is_valid_ip_pattern("10.0.0.0/33"));
        assert!(!is_valid_ip_pattern("not-an-ip"));
        assert!(!is_valid_ip_pattern(""));
    }

    #[test]
    fn validates_ipv6_and_cidr() {
        assert!(is_valid_ip_pattern("::1"));
        assert!(is_valid_ip_pattern("240e:1234::1"));
        assert!(is_valid_ip_pattern("2400:cb00::/32"));
        assert!(is_valid_ip_pattern("::/0"));
        assert!(!is_valid_ip_pattern("240e::/129"));
        assert!(!is_valid_ip_pattern("gggg::1"));
    }

    #[test]
    fn cidr_matches_both_versions() {
        let v4 = IpNetwork::parse("192.168.1.0/24").unwrap();
        assert!(v4.contains_ip(&"192.168.1.50".parse().unwrap()));
        assert!(!v4.contains_ip(&"192.168.2.1".parse().unwrap()));
        assert!(!v4.contains_ip(&"::1".parse().unwrap()));

        let v6 = IpNetwork::parse("240e::/16").unwrap();
        assert!(v6.contains_ip(&"240e:dead::1".parse().unwrap()));
        assert!(!v6.contains_ip(&"240f::1".parse().unwrap()));

        let any = IpNetwork::parse("::/0").unwrap();
        assert!(any.contains_ip(&"2001:db8::1".parse().unwrap()));
    }

    #[test]
    fn normalizes_patterns() {
        // Rust std 拒绝带前导零的 IPv4（八进制歧义，如 010 曾被解释为 8），
        // 这类输入应直接判无效，而不是猜测用户意图。
        assert_eq!(normalize_pattern("010.000.000.001"), None);
        assert!(!is_valid_ip_pattern("010.000.000.001"));
        // CIDR 主机位清零
        assert_eq!(
            normalize_pattern("192.168.1.50/24").as_deref(),
            Some("192.168.1.0/24")
        );
        // IPv6 压缩
        assert_eq!(
            normalize_pattern("2001:0db8:0000:0000:0000:0000:0000:0001").as_deref(),
            Some("2001:db8::1")
        );
        // v4-mapped 还原
        assert_eq!(
            normalize_pattern("::ffff:1.2.3.4").as_deref(),
            Some("1.2.3.4")
        );
        assert_eq!(normalize_pattern("garbage"), None);
    }

    #[test]
    fn classifies_known_ranges() {
        assert_eq!(classify_ip("127.0.0.1"), IpClass::Loopback);
        assert_eq!(classify_ip("::1"), IpClass::Loopback);
        assert_eq!(classify_ip("10.1.2.3"), IpClass::Private);
        assert_eq!(classify_ip("192.168.10.10"), IpClass::Private);
        assert_eq!(classify_ip("172.16.0.1"), IpClass::Private);
        assert_eq!(classify_ip("169.254.1.1"), IpClass::LinkLocal);
        assert_eq!(classify_ip("fe80::1"), IpClass::LinkLocal);
        assert_eq!(classify_ip("104.16.1.1"), IpClass::Cloudflare);
        assert_eq!(classify_ip("2400:cb00::1"), IpClass::Cloudflare);
        assert_eq!(classify_ip("8.8.8.8"), IpClass::Public);
        assert_eq!(classify_ip("not-ip"), IpClass::Unknown);
        assert!(!IpClass::Private.needs_geoip());
        assert!(IpClass::Cloudflare.needs_geoip());
    }

    #[test]
    fn direct_mode_ignores_spoofed_headers() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "1.2.3.4".parse().unwrap());
        headers.insert("cf-connecting-ip", "5.6.7.8".parse().unwrap());
        let peer: IpAddr = "127.0.0.1".parse().unwrap();
        let picked = pick_client_ip(&headers, Some(peer), TrustMode::Direct);
        assert_eq!(picked.as_deref(), Some("127.0.0.1"));
    }

    #[test]
    fn cloudflare_mode_prefers_cf_header() {
        let mut headers = HeaderMap::new();
        // 客户端在最左侧伪造，Cloudflare 在右侧追加真实链
        headers.insert("x-forwarded-for", "1.2.3.4, 104.16.0.1".parse().unwrap());
        headers.insert("cf-connecting-ip", "9.9.9.9".parse().unwrap());
        let peer: IpAddr = "127.0.0.1".parse().unwrap();
        let picked = pick_client_ip(&headers, Some(peer), TrustMode::Cloudflare);
        assert_eq!(picked.as_deref(), Some("9.9.9.9"));
    }

    #[test]
    fn proxy_hops_takes_rightmost_entry() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            "1.2.3.4, 10.0.0.1, 10.0.0.2".parse().unwrap(),
        );
        let peer: IpAddr = "10.0.0.2".parse().unwrap();
        let picked = pick_client_ip(&headers, Some(peer), TrustMode::ProxyHops(1));
        assert_eq!(picked.as_deref(), Some("10.0.0.2"));
        let picked2 = pick_client_ip(&headers, Some(peer), TrustMode::ProxyHops(2));
        assert_eq!(picked2.as_deref(), Some("10.0.0.1"));
    }

    #[test]
    fn falls_back_to_peer_when_headers_invalid() {
        let headers = HeaderMap::new();
        let peer: IpAddr = "192.168.1.5".parse().unwrap();
        assert_eq!(
            pick_client_ip(&headers, Some(peer), TrustMode::Cloudflare).as_deref(),
            Some("192.168.1.5")
        );
    }
}
