# luci-app-softethermg

面向 OpenWrt 的轻量级 **SoftEther VPN Server** 原生管理插件（LuCI 界面）。

本项目参照 **[openwrt-passwall](https://github.com/Openwrt-Passwall/openwrt-passwall)** 的现代架构与设计规范开发，**彻底摒弃了 Python、FastAPI、Uvicorn 和 Node.js**，直接利用 SoftEther 官方内建的 **JSON-RPC 2.0 API** 规范实现控制。

功能逐步对齐 **[DrSaeedHub/Softether-Manager](https://github.com/DrSaeedHub/Softether-Manager)**，通过 LuCI、Shell 与 vpncmd/JSON-RPC 实现，适配 OpenWrt。当前已支持的功能见下文，尚未覆盖上游全部 133 个管理接口。

* **极致轻量**：插件体积仅百余 KB，无常驻额外进程，零内存开销，即使在 16MB/32MB Flash 的嵌入式路由器上也能丝滑运行。
* **原生体验**：采用纯 LuCI-JS 打造，无缝集成进 OpenWrt 官方后台管理界面。
* **功能全面**：涵盖运行状态监控、虚拟 HUB 管理、用户与限速策略、SecureNAT (虚拟 NAT/DHCP)、L2TP/IPsec 与 OpenVPN 协议一键配置、实时会话监控与踢人。

---

## 一、 功能特性

1. **概览状态 (Overview)**
   - 实时监控 SoftEther VPN 守护进程运行状态、服务器版本及构建信息。
   - 动态轮询在线会话数、注册用户数、虚拟 HUB 数及全局出入网络流量。
2. **虚拟 HUB 管理 (Virtual Hubs)**
   - 虚拟交换机增删改查、单键上线/下线。
   - 汇总各 HUB 下注册用户数、活跃会话及数据包统计。
3. **用户与认证管理 (Users)**
   - 多 HUB 切换、按用户名/用户组/姓名/备注搜索，显示真实认证方式、登录次数与流量。
   - 用户的添加、资料编辑、删除、密码重置；编辑资料保留认证、到期时间及完整安全策略。
   - 支持创建用户时设置上行/下行限速 (QoS) 及并发登录限制。
   - 用户组的创建、资料编辑、删除，以及用户加入/退出组；已有组策略保留。
   - 用户和用户组的安全策略编辑：38 项接入、带宽、会话、地址、IPv4/IPv6 过滤及 VLAN 设置，显示继承来源，支持建立/移除独立策略。
   - 已有策略只提交改动字段；首次建立独立策略从当前有效策略复制，保存后回读实际状态，服务端不支持的字段不修改。限速单位为 bps。
   - 下载用户专属 SoftEther VPN Client `.vpn` 文件，支持编辑连接地址、端口和名称，可选在浏览器中嵌入密码。
   - `.vpn` 文件遵循上游的配置转义、SHA-0 密码散列、UTF-8 BOM 和 CRLF 格式；未嵌入密码时由客户端询问。
4. **虚拟 NAT 与 DHCP 服务 (SecureNAT)**
   - 单键开启/停用 SecureNAT。
   - 可视化配置虚拟网关 IP、子网掩码、DHCP 地址池起止范围及主 DNS 服务器。
5. **协议设置 (Protocols)**
   - **L2TP / IPsec**：配置 L2TP over IPsec、Raw L2TP 与 EtherIP / L2TPv3 开关、预共享密钥及默认 HUB。
   - **OpenVPN**：配置 UDP 监听端口列表（默认 1194），下载服务端生成的客户端模板 ZIP，包含 TUN/TAP `.ovpn` 文件、证书与说明。
   - **MS-SSTP**：读取和设置 SSTP 开关，支持 vpncmd 和 JSON-RPC 两种通信方式。
   - 保存时检查后台错误，并重新读取服务端状态确认生效。
6. **在线会话监控 (Sessions)**
   - 实时呈现当前连接的客户端真实 IP、主机名、TCP 连接数及传输数据量。
   - 一键断开（踢出）异常会话。
7. **服务器管理 (Server)**
   - TCP 监听端口的创建、启用、停用和删除，显示实际监听/失败状态，并保护当前面板连接端口。
   - 查看和下载服务器公钥证书，导入匹配的证书与未加密私钥，或生成并启用新的自签证书；更换后读取证书核对结果。
   - 下载当前 SoftEther 实例的配置备份，支持 vpncmd 和 JSON-RPC 两种方式。
   - 配置备份包含账号资料、密码散列和服务器私钥，导出需要写入管理权限。
8. **基本设置 (Settings)**
   - 插件启用开关：在“服务 → SoftEther VPN → 基本设置”中勾选或取消“启用插件”，点击“保存并应用”生效。
   - 关闭插件后停止后台连接与管理操作；托管模式下同时停止由插件启动的 VPN 服务，纯面板模式不影响已有或远程服务。
   - 管理目标地址及端口（默认 5555），支持纯面板和托管运行模式。
   - 一键修改 SoftEther 服务器主管理员密码并自动同步到配置。

---

## 二、 目录结构规范

```text
luci-app-softethermg/
├── Makefile                                       # OpenWrt 软件包构建 Makefile
├── root/
│   ├── etc/
│   │   ├── config/softethermg                     # UCI 配置文件
│   │   ├── init.d/softethermg                     # procd 启动与守护进程脚本
│   │   └── uci-defaults/luci-app-softethermg      # 初次安装默认初始化
│   └── usr/
│       ├── libexec/rpcd/luci.softethermg          # rpcd 插件 (ubus 接口提供者)
│       └── share/
│           ├── luci/menu.d/
│           │   └── luci-app-softethermg.json      # LuCI 导航菜单声明
│           ├── rpcd/acl.d/
│           │   └── luci-app-softethermg.json      # rpcd ubus 权限声明
│           └── softethermg/
│               ├── api.sh                         # Shell vpncmd / JSON-RPC 通信核心库
│               ├── policy.sh                      # 安全策略读取、继承和更新
│               └── policy.json                    # 策略字段、默认值、范围和说明
├── htdocs/luci-static/resources/view/softethermg/ # 现代 LuCI-JS 视图
│   ├── overview.js                                # 运行状态与概览
│   ├── hubs.js                                    # 虚拟 HUB 管理
│   ├── users.js                                   # 用户、用户组与连接文件下载
│   ├── client.js                                  # SoftEther Client .vpn 格式生成
│   ├── policy.js                                  # 用户/用户组安全策略编辑
│   ├── nat.js                                     # SecureNAT 虚拟路由/DHCP
│   ├── protocols.js                               # L2TP/IPsec 与 OpenVPN 协议
│   ├── sessions.js                                # 实时会话与踢人
│   ├── server.js                                  # TCP 监听、服务器证书和配置备份
│   └── settings.js                                # 基本设置与密码更改
└── po/                                            # 多语言国际化
    ├── templates/softethermg.pot
    └── zh_Hans/softethermg.po                     # 简体中文翻译
```

---

## 三、 安装与使用

### 依赖项
* `softether-vpnserver`（SoftEther VPN 核心，OpenWrt 官方软件源直接提供）
* `curl`（用于发送本地 JSON-RPC HTTP POST）
* `jsonfilter`（OpenWrt 系统内置轻量 JSON 提取器）
* `jshn`（OpenWrt 原生 JSON 工具，用于编辑账号时保留已有认证和安全策略）

### 方式 1：源码编译打包 (推荐)
1. 将本项目目录放入 OpenWrt 源码树或 SDK 的 `package/` 目录：
   ```bash
   cd openwrt
   git clone <本仓库地址> package/luci-app-softethermg
   ```
2. 进入配置菜单勾选插件：
   ```bash
   make menuconfig
   # 依次进入：LuCI -> 3. Applications -> 勾选 <*> luci-app-softethermg
   ```
3. 单独编译该包：
   ```bash
   make package/luci-app-softethermg/compile V=s
   ```
4. 编译输出的 `.apk` 文件（OpenWrt 24.x+ 采用 apk 包格式）位于 `bin/packages/<架构>/luci/` 或 `base/`。上传至路由器后使用 `apk` 安装：
   ```bash
   apk add --allow-untrusted ./luci-app-softethermg*.apk
   ```
   *(注：若仍在使用旧版 OpenWrt 21/22/23，系统会自动生成 `.ipk`，使用 `opkg install` 即可)*

---

### 方式 2：真机免编译直接部署 (调试与快速体验)
若路由器已运行官方 OpenWrt：
1. 在路由器上安装基础依赖：
   ```bash
   apk update
   apk add softether-vpnserver curl jsonfilter jshn
   # (旧版系统使用: opkg update && opkg install softether-vpnserver curl jsonfilter jshn)
   ```
2. 将本工程的 `root/` 与 `htdocs/` 目录中的文件，按对应的绝对路径复制到路由器的文件系统中：
   - `root/*` 覆盖到路由器的 `/` 根目录对应位置
   - `htdocs/luci-static/resources/view/softethermg/*` 复制到路由器的 `/www/luci-static/resources/view/softethermg/`
3. 赋予脚本执行权限：
   ```bash
   chmod +x /etc/init.d/softethermg
   chmod +x /usr/share/softethermg/api.sh
   chmod +x /usr/libexec/rpcd/luci.softethermg
   ```
4. 重启 LuCI 相关后台守护进程：
   ```bash
   /etc/init.d/rpcd restart
   /etc/init.d/uhttpd restart
   /etc/init.d/softethermg enable
   /etc/init.d/softethermg start
   ```
5. 刷新 OpenWrt Web 界面，在 **`服务` -> `SoftEther VPN`** 菜单中进入管理页面。

---

## 四、 常见问题 (FAQ)

1. **为什么状态概览提示“未运行或连接超时”？**
   - 确认后台服务已启动：检查 `ps | grep vpnserver`。
   - 检查 API 监听端口（默认 5555）是否通畅。
   - 若首次使用 SoftEther，请进入**基本设置**配置正确的管理员连接密码。
2. **能否远程管理其他机器上的 SoftEther 服务端？**
   - 可以。在“基本设置”中将 `API 监听地址` 改为目标服务器的 IP，即可实现跨主机管理。
3. **如何下载 OpenVPN 客户端模板？**
   - 进入“服务 → SoftEther VPN → 协议设置”，启用 OpenVPN、填写 UDP 端口，点击“保存并应用设置”。
   - 点击“下载 OpenVPN 模板 (.zip)”。模板由当前连接的 SoftEther 服务端生成，使用服务端证书与实际配置，兼容纯面板和托管模式。
   - 解压后，远程接入通常使用文件名含 `remote_access_l3` 的 TUN 配置；网桥场景使用含 `site_to_site_bridge_l2` 的 TAP 配置。
   - 导入 OpenVPN 客户端前，检查 `.ovpn` 中的 `remote` 地址及端口，并确保路由器防火墙放行对应 UDP 端口。多 HUB 用户使用 `用户名@HUB名` 登录。
   - 需要服务器管理员权限；插件关闭、OpenVPN 未启用或服务端拒绝导出时会提示失败。
   - 这是 OpenVPN 的 `.ovpn` 模板 ZIP，与用户管理页面下载的 SoftEther VPN Client `.vpn` 连接文件格式不同。
4. **如何下载用户的 SoftEther VPN Client `.vpn` 文件？**
   - 在“服务 → SoftEther VPN → 用户管理”中选择 HUB，点击目标用户的“下载 .vpn”。
   - 填写客户端可访问的服务端地址和 SoftEther TCP 监听端口，下载后导入 SoftEther VPN Client，并核对服务端证书。页面读取可用监听端口，优先选择 443；未监听 443 时选择其他可用端口。端口映射场景需手动填写外部端口。
   - 默认不嵌入密码；需要时勾选“嵌入密码”并输入。密码仅在当前浏览器中处理，不上传或保存在路由器上。
   - 密码认证使用 SoftEther 的 SHA-0 散列；RADIUS/NT 认证按客户端格式写入明文密码。持有带凭据文件的人可使用该凭据连接。
   - 证书认证需在客户端另外配置用户证书；此版本不从服务端恢复或长期保存用户密码，也不提供上游的全部代理/模板选项。
5. **用户组和策略目前支持到什么程度？**
   - 支持组的创建、资料编辑、删除和用户成员调整；删除组保留用户账号并解除成员关系。
   - 编辑组资料保留已有组策略，编辑用户资料或重置密码保留原有到期时间和策略。用户和用户组列表中的“安全策略”可修改服务端支持的 38 项设置；全部认证方式的配置和流量总额配额尚未完整对齐上游。
6. **旧版 JSON-RPC 创建的用户显示“匿名认证”怎么办？**
   - 旧版创建用户时认证类型设置有误，本版已修复新建用户和重置密码的逻辑。若旧版通过 JSON-RPC 创建的账号显示“匿名认证”，请使用“重置密码”将其改为密码认证。
   - 用户组、到期时间和安全策略会保留；原本有意设置为匿名认证的账号不会自动修改。
7. **如何管理 TCP 端口、服务器证书和备份？**
   - 进入“服务 → SoftEther VPN → 服务器管理”。TCP 端口供 SoftEther、SSTP 和管理连接使用；OpenVPN 的 UDP 端口在“协议设置”中配置。
   - 添加或修改后读取服务端实际状态；“无法监听”通常表示端口占用或权限问题。外网访问还需要配置路由器防火墙和端口映射。
   - 当前面板连接端口不能停用或删除，请先在“基本设置”中切换到另一个可用的管理端口。
   - 证书支持单个 PEM/DER 文件与匹配的未加密私钥，每个文件最大 64 KiB。服务器负责验证密钥匹配及算法兼容性。证书更换或重新生成后，客户端可能需要重新确认信任。
   - 证书查看/下载接口只返回公钥证书。导入私钥的临时文件使用私有权限并在操作后清理；JSON-RPC 请求体通过标准输入交给 curl。
   - 点击“下载配置备份 (.config)”可导出当前 SoftEther 服务端配置，备份包含账号和密钥等敏感资料，请妥善保存。插件连接设置位于 `/etc/config/softethermg`。
   - 本版提供配置备份下载，配置恢复、自动证书签发与完整信任链管理尚未对齐上游。
8. **如何编辑用户或用户组的安全策略？**
   - 进入“用户管理”，在用户或用户组的操作列点击“安全策略”。编辑器显示当前来源：独立策略、继承用户组或默认策略。
   - 勾选“应用独立安全策略”，以当前有效值建立独立策略，再修改需要的项目。用户独立策略是一整份策略，不会继续逐项继承后续组策略变更。
   - 取消勾选并保存会移除独立策略；用户恢复用户组或默认策略，用户组成员则按自己的独立策略或默认策略运行。
   - 支持接入权限、并发登录、连接数、超时、上下行限速、MAC/IP 数量、DHCP、桥接/路由过滤、IPv6 和 VLAN。限速单位为 bit/s，`10000000` 即 10 Mbps；策略的 0 值含义和合法范围在各字段说明中标明。
   - 命令行模式分步写入。首次建立独立策略时先拒绝新登录，复制和核对成功后再按“允许登录”的设置放行；失败可能部分生效，编辑器会重新显示实际策略。若首次配置失败仍处于拒绝登录状态，可重试或取消独立策略以恢复继承。
   - 已有账号的认证、密码散列、到期时间、成员关系以及未编辑的策略字段会保留。只读策略接口不返回密码散列或证书私钥。
   - 策略一般在用户重新建立 VPN 会话后应用；修改“允许登录”不自动断开已有会话，需要时在“在线会话”页断开连接。
9. **升级后提示 `RPC call ... Access denied` 怎么办？**
   - 这通常表示 LuCI 当前登录会话仍使用升级前的 RPC 权限；并非 SoftEther 管理员密码错误。
   - 本版 APK 的首次安装和升级均会执行同一刷新脚本，重载 rpcd 并清理 LuCI 菜单缓存，使已有会话按最新 ACL 重新授权。IPK 安装与升级使用相同处理。
   - 旧版可在路由器 SSH 中执行以下命令，然后刷新浏览器；仍失败时退出 LuCI 并重新登录。
     ```sh
     /etc/init.d/rpcd reload
     rm -f /tmp/luci-indexcache /tmp/luci-indexcache.*.json /tmp/luci-modulecache/*
     ```
   - 使用受限账号时，需要由管理员为该账号分配 `luci-app-softethermg` 权限组。插件菜单声明了对应 ACL 依赖，不会自行扩大账号权限。
