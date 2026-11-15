#!/bin/sh

# Image builds must not touch the build host's services or LuCI caches.
[ -z "${IPKG_INSTROOT:-}" ] || exit 0

if [ -x /etc/uci-defaults/luci-app-softethermg ]; then
	/etc/uci-defaults/luci-app-softethermg
fi

rm -f /tmp/luci-indexcache /tmp/luci-indexcache.*.json /tmp/luci-modulecache/* 2>/dev/null || true

# rpcd reload rebuilds existing login sessions with the updated ACL files.
if [ -x /etc/init.d/rpcd ]; then
	/etc/init.d/rpcd reload >/dev/null 2>&1 || /etc/init.d/rpcd restart >/dev/null 2>&1
fi

exit 0
