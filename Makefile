include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-softethermg
PKG_VERSION:=1.0.10
PKG_RELEASE:=1

LUCI_TITLE:=LuCI support for SoftEther VPN Server Manager
LUCI_DEPENDS:=+curl +jsonfilter
LUCI_PKGARCH:=all

define Package/$(PKG_NAME)/conffiles
/etc/config/softethermg
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
