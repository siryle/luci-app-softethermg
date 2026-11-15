# luci-app-softethermg

面向 OpenWrt 的轻量级 **SoftEther VPN Server** 原生管理插件（LuCI 界面）。

本项目参照 **[openwrt-passwall](https://github.com/Openwrt-Passwall/openwrt-passwall)** 的现代架构与设计规范开发，**彻底摒弃了 Python、FastAPI、Uvicorn 和 Node.js**，直接利用 SoftEther 官方内建的 **JSON-RPC 2.0 API** 规范实现控制。

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
   - 多 HUB 切换管理。
   - 用户的添加、删除、密码重置。
   - 支持上行/下行速率配额限制 (QoS) 及多点并发登录限制。
4. **虚拟 NAT 与 DHCP 服务 (SecureNAT)**
   - 单键开启/停用 SecureNAT。
   - 可视化配置虚拟网关 IP、子网掩码、DHCP 地址池起止范围及主 DNS 服务器。
5. **协议设置 (Protocols)**
   - **L2TP / IPsec**：免客户端支持 iOS、Android、macOS 及 Windows 自带 VPN。
   - **OpenVPN**：配置监听端口列表（默认 1194）。
   - **MS-SSTP**：基于 HTTPS 443 端口的 Windows 原生 SSL-VPN。
6. **在线会话监控 (Sessions)**
   - 实时呈现当前连接的客户端真实 IP、主机名、TCP 连接数及传输数据量。
   - 一键断开（踢出）异常会话。
7. **基本设置 (Settings)**
   - UCI 服务开机自启、管理 API 监听主机及端口（默认 5555）。
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
│               └── api.sh                         # 纯 Shell JSON-RPC 通信核心库
├── htdocs/luci-static/resources/view/softethermg/ # 现代 LuCI-JS 视图
│   ├── overview.js                                # 运行状态与概览
│   ├── hubs.js                                    # 虚拟 HUB 管理
│   ├── users.js                                   # 用户与限速管理
│   ├── nat.js                                     # SecureNAT 虚拟路由/DHCP
│   ├── protocols.js                               # L2TP/IPsec 与 OpenVPN 协议
│   ├── sessions.js                                # 实时会话与踢人
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
   apk add softether-vpnserver curl jsonfilter
   # (旧版系统使用: opkg update && opkg install softether-vpnserver curl jsonfilter)
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
5. 刷新 OpenWrt Web 界面，导航栏顶部会出现 **`VPN` -> `SoftEther VPN`** 菜单。

---

## 四、 常见问题 (FAQ)

1. **为什么状态概览提示“未运行或连接超时”？**
   - 确认后台服务已启动：检查 `ps | grep vpnserver`。
   - 检查 API 监听端口（默认 5555）是否通畅。
   - 若首次使用 SoftEther，请进入**基本设置**配置正确的管理员连接密码。
2. **能否远程管理其他机器上的 SoftEther 服务端？**
   - 可以。在“基本设置”中将 `API 监听地址` 改为目标服务器的 IP，即可实现跨主机管理。
