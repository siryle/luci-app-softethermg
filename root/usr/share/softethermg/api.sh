#!/bin/sh
# /usr/share/softethermg/api.sh
# Dual-engine backend for SoftEther VPN Server: Native CLI (vpncmd) + JSON-RPC

CONFIG="softethermg"

json_string() {
	printf '%s\n' "$1" | awk '
		BEGIN {
			for (i = 1; i < 32; i++) escapes[sprintf("%c", i)] = sprintf("\\u%04x", i)
			printf "\""
		}
		{
			if (NR > 1) printf "\\n"
			for (i = 1; i <= length($0); i++) {
				c = substr($0, i, 1)
				if (c == "\\") printf "\\\\"
				else if (c == "\"") printf "\\\""
				else if (c in escapes) printf "%s", escapes[c]
				else printf "%s", c
			}
		}
		END { printf "\"" }
	'
}

api_error() {
	printf '{"jsonrpc":"2.0","error":{"code":%s,"message":%s},"id":"1"}\n' "${2:--32000}" "$(json_string "$1")"
}

get_config_value() {
	local key="$1"
	local default="$2"
	local val
	val=$(uci -q get "${CONFIG}.global.${key}")
	echo "${val:-$default}"
}

get_api_type() {
	get_config_value "api_type" "vpncmd"
}

get_api_host() {
	get_config_value "api_host" "127.0.0.1"
}

get_api_port() {
	get_config_value "api_port" "5555"
}

get_admin_password() {
	uci -q get "${CONFIG}.global.admin_password" || echo ""
}

find_vpncmd() {
	local configured_path
	configured_path=$(get_config_value "vpncmd_path" "")
	if [ -n "$configured_path" ] && [ -x "$configured_path" ]; then
		echo "$configured_path"
	elif [ -x "/usr/libexec/softethervpn/vpncmd" ]; then
		echo "/usr/libexec/softethervpn/vpncmd"
	elif [ -x "/usr/bin/vpncmd" ]; then
		echo "/usr/bin/vpncmd"
	elif command -v vpncmd >/dev/null 2>&1; then
		command -v vpncmd
	elif [ -x "/usr/libexec/softether/vpncmd" ]; then
		echo "/usr/libexec/softether/vpncmd"
	else
		echo "vpncmd"
	fi
}

# ===========================================================================
# 1. vpncmd Native CLI Engine
# ===========================================================================

run_vpncmd() {
	local hub="$1"
	shift
	local cmd="$*"
	local vcmd
	vcmd=$(find_vpncmd)
	local host port pass
	host=$(get_api_host)
	port=$(get_api_port)
	pass=$(get_admin_password)

	local args="${host}:${port} /SERVER"
	[ -n "$pass" ] && args="$args /PASSWORD:${pass}"
	[ -n "$hub" ] && args="$args /HUB:${hub}"

	local vcmd_dir
	if [ -f "$vcmd" ]; then
		vcmd_dir="$(dirname "$vcmd")"
	else
		vcmd_dir="/usr/libexec/softethervpn"
	fi

	if [ -d "$vcmd_dir" ]; then
		(cd "$vcmd_dir" && "$vcmd" $args /CSV /CMD $cmd < /dev/null 2>/dev/null)
	else
		$vcmd $args /CSV /CMD $cmd < /dev/null 2>/dev/null
	fi
}

# --- Server Status via vpncmd ---
cmd_get_server_status() {
	local raw info_raw banner
	raw=$(run_vpncmd "" "ServerStatusGet" 2>/dev/null)
	info_raw=$(run_vpncmd "" "ServerInfoGet" 2>/dev/null)

	# 获取本地 vpncmd 原生版本横幅作为可靠保底（免网络、免鉴权）
	local vcmd vcmd_dir
	vcmd=$(find_vpncmd)
	if [ -f "$vcmd" ]; then
		vcmd_dir="$(dirname "$vcmd")"
		banner=$( (cd "$vcmd_dir" && "$vcmd" /? < /dev/null 2>&1) | head -n 10 )
	fi

	if [ -z "$raw" ] && [ -z "$info_raw" ] && [ -z "$banner" ]; then
		echo '{"jsonrpc":"2.0","error":{"code":-32000,"message":"vpncmd execution failed or server unreachable"},"id":"1"}'
		return 1
	fi

	printf '%s\n%s\n%s\n' "$raw" "$info_raw" "$banner" | awk '
	BEGIN {
		print "{\"jsonrpc\":\"2.0\",\"result\":{"
		first = 1
	}
	{
		sub(/\r$/, "")
		if ($0 ~ /^[Vv]ersion / && ver == "") {
			ver = $0
		}
		if ($0 ~ /^[Cc]ompiled / && build == "") {
			build = $0
		}
		idx = index($0, ",")
		if (idx > 0) {
			k = substr($0, 1, idx - 1)
			v = substr($0, idx + 1)
			gsub(/^"|"$/, "", k)
			gsub(/^"|"$/, "", v)

			if (k == "Server Version String" || k == "Version") ver = v
			else if (k == "Server Build Info String" || k == "Build") build = v
			else if (k == "Product Name") prod = v
			else if (k == "Server Type") type = v
			else if (k == "Number of Virtual Hubs") num_hub = v
			else if (k == "Number of Sessions") num_sessions = v
			else if (k == "Number of Users") num_users = v
			else if (k ~ /Incoming.*Total Size/ || k ~ /Total Size of Incoming.*Packets/) {
				gsub(/[^0-9]/, "", v)
				rx = v
			}
			else if (k ~ /Outgoing.*Total Size/ || k ~ /Total Size of Outgoing.*Packets/) {
				gsub(/[^0-9]/, "", v)
				tx = v
			}
		}
	}
	END {
		gsub(/"/, "", ver)
		gsub(/"/, "", build)
		gsub(/"/, "", prod)
		gsub(/"/, "", type)

		if (ver != "") { printf "\"ServerVersionString_str\":\"%s\"", ver; first = 0 }
		if (build != "") { if (!first) printf ","; printf "\"ServerBuildInfoString_str\":\"%s\"", build; first = 0 }
		if (prod != "") { if (!first) printf ","; printf "\"ProductName_str\":\"%s\"", prod; first = 0 }
		if (type != "") { if (!first) printf ","; printf "\"ServerType_str\":\"%s\"", type; first = 0 }
		if (num_hub != "") { if (!first) printf ","; printf "\"NumHub_u32\":%d", num_hub; first = 0 }
		if (num_users != "") { if (!first) printf ","; printf "\"NumUsers_u32\":%d", num_users; first = 0 }
		if (num_sessions != "") { if (!first) printf ","; printf "\"NumSessions_u32\":%d", num_sessions; first = 0 }
		if (rx != "") { if (!first) printf ","; printf "\"Recv.BroadcastBytes_u64\":%s", rx; first = 0 }
		if (tx != "") { if (!first) printf ","; printf "\"Send.BroadcastBytes_u64\":%s", tx; first = 0 }
		print "},\"id\":\"1\"}"
	}'
}

# --- Hubs via vpncmd ---
cmd_enum_hubs() {
	local raw
	raw=$(run_vpncmd "" "HubList")
	if [ -z "$raw" ]; then
		echo '{"jsonrpc":"2.0","result":{"HubList":[]},"id":"1"}'
		return 0
	fi

	echo "$raw" | awk '
	BEGIN {
		print "{\"jsonrpc\":\"2.0\",\"result\":{\"HubList\":["
		cnt = 0
		in_item = 0
	}
	{
		sub(/\r$/, "")
		if ($0 ~ /^Item,Value/) {
			if (in_item && cur_name != "") {
				if (cnt > 0) printf ","
				printf "{\"HubName_str\":\"%s\",\"Online_bool\":%s,\"NumUsers_u32\":%d,\"NumSessions_u32\":%d}", cur_name, (cur_online=="Online"?"true":"false"), cur_users, cur_sessions
				cnt++
			}
			in_item = 1
			cur_name = ""; cur_online = "Online"; cur_users = 0; cur_sessions = 0
			next
		}
		idx = index($0, ",")
		if (idx > 0) {
			k = substr($0, 1, idx - 1)
			v = substr($0, idx + 1)
			gsub(/^"|"$/, "", k)
			gsub(/^"|"$/, "", v)
			if (k == "Virtual Hub Name" || k ~ /Hub Name/) cur_name = v
			else if (k == "Status") cur_online = v
			else if (k == "Users" || k ~ /Users/) { gsub(/[^0-9]/, "", v); cur_users = (v==""?0:v) }
			else if (k == "Sessions" || k ~ /Sessions/) { gsub(/[^0-9]/, "", v); cur_sessions = (v==""?0:v) }
		}
	}
	END {
		if (in_item && cur_name != "") {
			if (cnt > 0) printf ","
			printf "{\"HubName_str\":\"%s\",\"Online_bool\":%s,\"NumUsers_u32\":%d,\"NumSessions_u32\":%d}", cur_name, (cur_online=="Online"?"true":"false"), cur_users, cur_sessions
		}
		print "]},\"id\":\"1\"}"
	}'
}

cmd_create_hub() {
	local hub="$1"
	local pass="${2:-none}"
	local online="${3:-true}"
	run_vpncmd "" "HubCreate $hub /PASSWORD:$pass" >/dev/null 2>&1
	if [ "$online" = "false" ]; then
		run_vpncmd "" "HubOffline $hub" >/dev/null 2>&1
	fi
	echo '{"jsonrpc":"2.0","result":{},"id":"1"}'
}

cmd_delete_hub() {
	local hub="$1"
	run_vpncmd "" "HubDelete $hub" >/dev/null 2>&1
	echo '{"jsonrpc":"2.0","result":{},"id":"1"}'
}

cmd_set_hub_online() {
	local hub="$1"
	local online="${2:-true}"
	if [ "$online" = "true" ]; then
		run_vpncmd "" "HubOnline $hub" >/dev/null 2>&1
	else
		run_vpncmd "" "HubOffline $hub" >/dev/null 2>&1
	fi
	echo '{"jsonrpc":"2.0","result":{},"id":"1"}'
}

cmd_get_hub_status() {
	local hub="${1:-DEFAULT}"
	local raw_nat
	raw_nat=$(run_vpncmd "$hub" "SecureNatStatusGet" 2>/dev/null)
	local is_nat="false"
	if echo "$raw_nat" | grep -qi "The command completed successfully"; then
		is_nat="true"
	fi
	echo "{\"jsonrpc\":\"2.0\",\"result\":{\"SecureNATEnabled_bool\":$is_nat},\"id\":\"1\"}"
}

# --- Users via vpncmd ---
cmd_enum_users() {
	local hub="${1:-DEFAULT}"
	local raw
	raw=$(run_vpncmd "$hub" "UserList")
	if [ -z "$raw" ]; then
		echo '{"jsonrpc":"2.0","result":{"UserList":[]},"id":"1"}'
		return 0
	fi

	echo "$raw" | awk '
	BEGIN {
		print "{\"jsonrpc\":\"2.0\",\"result\":{\"UserList\":["
		cnt = 0
		in_item = 0
	}
	{
		sub(/\r$/, "")
		if ($0 ~ /^Item,Value/) {
			if (in_item && cur_name != "") {
				if (cnt > 0) printf ","
				printf "{\"Name_str\":\"%s\",\"AuthType_u32\":0,\"Realname_utf\":\"%s\",\"Note_utf\":\"%s\",\"NumLogin_u32\":%d}", cur_name, cur_real, cur_note, cur_logins
				cnt++
			}
			in_item = 1
			cur_name = ""; cur_real = ""; cur_note = ""; cur_logins = 0
			next
		}
		idx = index($0, ",")
		if (idx > 0) {
			k = substr($0, 1, idx - 1)
			v = substr($0, idx + 1)
			gsub(/^"|"$/, "", k)
			gsub(/^"|"$/, "", v)
			if (k == "User Name") cur_name = v
			else if (k == "Full Name") cur_real = v
			else if (k == "Description") cur_note = v
			else if (k == "Num Logins") cur_logins = v
		}
	}
	END {
		if (in_item && cur_name != "") {
			if (cnt > 0) printf ","
			printf "{\"Name_str\":\"%s\",\"AuthType_u32\":0,\"Realname_utf\":\"%s\",\"Note_utf\":\"%s\",\"NumLogin_u32\":%d}", cur_name, cur_real, cur_note, cur_logins
		}
		print "]},\"id\":\"1\"}"
	}'
}

cmd_create_user() {
	local hub="$1"
	local user="$2"
	local pass="${3:-}"
	local realname="${4:-none}"
	local note="${5:-none}"
	local max_up="${7:-0}"
	local max_down="${8:-0}"
	local multi="${9:-0}"

	run_vpncmd "$hub" "UserCreate $user /GROUP:none /REALNAME:\"$realname\" /NOTE:\"$note\"" >/dev/null 2>&1
	if [ -n "$pass" ]; then
		run_vpncmd "$hub" "UserPasswordSet $user /PASSWORD:\"$pass\"" >/dev/null 2>&1
	fi
	[ "$max_up" -gt 0 ] && run_vpncmd "$hub" "UserPolicySet $user /NAME:MaxUpload /VALUE:$max_up" >/dev/null 2>&1
	[ "$max_down" -gt 0 ] && run_vpncmd "$hub" "UserPolicySet $user /NAME:MaxDownload /VALUE:$max_down" >/dev/null 2>&1
	[ "$multi" -gt 0 ] && run_vpncmd "$hub" "UserPolicySet $user /NAME:MultiLogins /VALUE:$multi" >/dev/null 2>&1

	echo '{"jsonrpc":"2.0","result":{},"id":"1"}'
}

cmd_set_user_password() {
	local hub="$1"
	local user="$2"
	local pass="$3"
	run_vpncmd "$hub" "UserPasswordSet $user /PASSWORD:\"$pass\"" >/dev/null 2>&1
	echo '{"jsonrpc":"2.0","result":{},"id":"1"}'
}

cmd_delete_user() {
	local hub="$1"
	local user="$2"
	run_vpncmd "$hub" "UserDelete $user" >/dev/null 2>&1
	echo '{"jsonrpc":"2.0","result":{},"id":"1"}'
}

# --- SecureNAT via vpncmd ---
cmd_get_secure_nat() {
	local hub="${1:-DEFAULT}"
	local nat_raw
	local dhcp_raw
	nat_raw=$(run_vpncmd "$hub" "NatGet" 2>/dev/null)
	dhcp_raw=$(run_vpncmd "$hub" "DhcpGet" 2>/dev/null)

	local ip="192.168.30.1"
	local mask="255.255.255.0"
	local start="192.168.30.10"
	local end="192.168.30.200"
	local gw="192.168.30.1"
	local dns="192.168.30.1"

	echo "{\"jsonrpc\":\"2.0\",\"result\":{\"UseNat_bool\":true,\"UseDhcp_bool\":true,\"Ip_ip\":\"$ip\",\"Mask_ip\":\"$mask\",\"DhcpLeaseIPStart_ip\":\"$start\",\"DhcpLeaseIPEnd_ip\":\"$end\",\"DhcpGatewayAddress_ip\":\"$gw\",\"DhcpDnsServerAddress_ip\":\"$dns\"},\"id\":\"1\"}"
}

cmd_set_secure_nat() {
	local hub="$1"
	local ip="${4:-192.168.30.1}"
	local mask="${5:-255.255.255.0}"
	local dhcp_start="${6:-192.168.30.10}"
	local dhcp_end="${7:-192.168.30.200}"
	local dhcp_mask="${8:-255.255.255.0}"
	local gateway="${9:-192.168.30.1}"
	local dns="${10:-192.168.30.1}"

	run_vpncmd "$hub" "SecureNatHostSet /IP:$ip /MASK:$mask" >/dev/null 2>&1
	run_vpncmd "$hub" "DhcpSet /START:$dhcp_start /END:$dhcp_end /MASK:$dhcp_mask /EXPIRE:7200 /GW:$gateway /DNS:$dns /DNS2:none /DOMAIN:none /LOG:yes" >/dev/null 2>&1
	echo '{"jsonrpc":"2.0","result":{},"id":"1"}'
}

cmd_enable_secure_nat() {
	local hub="${1:-DEFAULT}"
	run_vpncmd "$hub" "SecureNatEnable" >/dev/null 2>&1
	echo '{"jsonrpc":"2.0","result":{},"id":"1"}'
}

cmd_disable_secure_nat() {
	local hub="${1:-DEFAULT}"
	run_vpncmd "$hub" "SecureNatDisable" >/dev/null 2>&1
	echo '{"jsonrpc":"2.0","result":{},"id":"1"}'
}

# --- Protocols via vpncmd ---
vpncmd_csv_value() {
	printf '%s\n' "$1" | awk -v pattern="$2" '
		{
			sub(/\r$/, "")
			idx = index($0, ",")
			if (!idx) next
			key = substr($0, 1, idx - 1)
			gsub(/^"|"$/, "", key)
			if (tolower(key) !~ pattern) next
			value = substr($0, idx + 1)
			if (value ~ /^".*"$/) {
				value = substr(value, 2, length(value) - 2)
				gsub(/""/, "\"", value)
			}
			print value
			exit
		}
	'
}

vpncmd_csv_bool() {
	case "$(vpncmd_csv_value "$1" "$2")" in
		Yes|yes|true|Enabled) echo true ;;
		No|no|false|Disabled) echo false ;;
		*) return 1 ;;
	esac
}

cmd_get_ipsec() {
	local raw l2tp raw_l2tp etherip psk hub
	if ! raw=$(run_vpncmd "" "IPsecGet") ||
		! l2tp=$(vpncmd_csv_bool "$raw" "^l2tp over ipsec server function enabled$") ||
		! raw_l2tp=$(vpncmd_csv_bool "$raw" "^raw l2tp server function enabled$") ||
		! etherip=$(vpncmd_csv_bool "$raw" "^etherip / l2tpv3 over ipsec server function enabled$"); then
		api_error "Unable to read IPsec settings. Check the server address, password and administrator permissions."
		return 1
	fi
	psk=$(vpncmd_csv_value "$raw" "^ipsec pre-shared key string$")
	hub=$(vpncmd_csv_value "$raw" "^name of default virtual hub$")
	printf '{"jsonrpc":"2.0","result":{"L2TP_IPsec_bool":%s,"L2TP_Raw_bool":%s,"EtherIP_IPsec_bool":%s,"IPsec_Secret_str":%s,"L2TP_DefaultHub_str":%s},"id":"1"}\n' \
		"$l2tp" "$raw_l2tp" "$etherip" "$(json_string "$psk")" "$(json_string "$hub")"
}

cmd_set_ipsec() {
	local l2tp="${1:-true}" psk="${2:-vpn}" hub="${3:-DEFAULT}"
	local raw_l2tp="${4:-false}" etherip="${5:-false}"
	local l2tp_opt="no" raw_opt="no" etherip_opt="no"
	[ "$l2tp" = "true" ] && l2tp_opt="yes"
	[ "$raw_l2tp" = "true" ] && raw_opt="yes"
	[ "$etherip" = "true" ] && etherip_opt="yes"

	# vpncmd parses this command string itself; reject values that could add options.
	case "$psk$hub" in
		*[[:space:][:cntrl:]]*|*\"*|*\\*|*/*)
			api_error "In vpncmd mode, the IPsec key and hub name cannot contain spaces, quotes, backslashes or slashes." -32602
			return 1 ;;
	esac
	if ! run_vpncmd "" "IPsecEnable /L2TP:$l2tp_opt /L2TPRAW:$raw_opt /ETHERIP:$etherip_opt /PSK:$psk /DEFAULTHUB:$hub" >/dev/null; then
		api_error "Unable to save IPsec settings. Check the server connection and administrator permissions."
		return 1
	fi
	echo '{"jsonrpc":"2.0","result":{},"id":"1"}'
}

cmd_get_openvpn() {
	local raw sstp_raw ovpn sstp ports
	if ! raw=$(run_vpncmd "" "OpenVpnGet") ||
		! sstp_raw=$(run_vpncmd "" "SstpGet") ||
		! ovpn=$(vpncmd_csv_bool "$raw" "^openvpn clone server enabled$") ||
		! sstp=$(vpncmd_csv_bool "$sstp_raw" "^sstp vpn clone server enabled$"); then
		api_error "Unable to read OpenVPN/SSTP settings. Check the server connection and vpncmd version."
		return 1
	fi
	ports=$(vpncmd_csv_value "$raw" "^udp port list$")
	printf '{"jsonrpc":"2.0","result":{"EnableOpenVPN_bool":%s,"OpenVPNPortList_str":%s,"EnableSSTP_bool":%s},"id":"1"}\n' \
		"$ovpn" "$(json_string "$ports")" "$sstp"
}

cmd_set_openvpn() {
	local openvpn="${1:-true}" ports="${2:-1194}" sstp="${3:-false}"
	local ovpn_opt="no" sstp_opt="no"
	[ "$openvpn" = "true" ] && ovpn_opt="yes"
	[ "$sstp" = "true" ] && sstp_opt="yes"

	if ! run_vpncmd "" "OpenVpnEnable $ovpn_opt /PORTS:$ports" >/dev/null ||
		! run_vpncmd "" "SstpEnable $sstp_opt" >/dev/null; then
		api_error "Unable to save OpenVPN/SSTP settings. Some settings may have changed; reload to check the server state."
		return 1
	fi
	echo '{"jsonrpc":"2.0","result":{},"id":"1"}'
}

cmd_make_openvpn_config() (
	umask 077
	export_dir=$(mktemp -d /tmp/softethermg-openvpn.XXXXXX) || {
		api_error "Unable to create a temporary directory for the OpenVPN configuration."
		exit 1
	}
	trap 'rm -rf "$export_dir"' 0
	trap 'exit 1' HUP INT TERM

	if ! run_vpncmd "" "OpenVpnMakeConfig $export_dir/openvpn_config.zip" >/dev/null ||
		[ ! -s "$export_dir/openvpn_config.zip" ]; then
		api_error "Unable to export OpenVPN configuration. Enable OpenVPN and save its settings first; server administrator access is required."
		exit 1
	fi
	encoded=$(base64 < "$export_dir/openvpn_config.zip") || {
		api_error "Unable to encode the OpenVPN configuration archive."
		exit 1
	}
	printf '{"jsonrpc":"2.0","result":{"Buffer_bin":"%s"},"id":"1"}\n' "$(printf '%s' "$encoded" | tr -d '\r\n')"
)

# --- Sessions via vpncmd ---
cmd_enum_sessions() {
	local hub="${1:-DEFAULT}"
	local raw
	raw=$(run_vpncmd "$hub" "SessionList")
	if [ -z "$raw" ]; then
		echo '{"jsonrpc":"2.0","result":{"SessionList":[]},"id":"1"}'
		return 0
	fi

	echo "$raw" | awk '
	BEGIN {
		print "{\"jsonrpc\":\"2.0\",\"result\":{\"SessionList\":["
		cnt = 0
		in_item = 0
	}
	{
		sub(/\r$/, "")
		if ($0 ~ /^Item,Value/) {
			if (in_item && cur_name != "") {
				if (cnt > 0) printf ","
				printf "{\"Name_str\":\"%s\",\"ClientIP_ip\":\"%s\",\"Hostname_str\":\"%s\",\"Username_str\":\"%s\",\"CurrentNumTcp_u32\":%d,\"PacketSize_u64\":%d,\"CreatedTime_dt\":\"%s\"}", cur_name, cur_ip, cur_host, cur_user, cur_tcp, cur_bytes, cur_time
				cnt++
			}
			in_item = 1
			cur_name = ""; cur_ip = "-"; cur_host = "-"; cur_user = "-"; cur_tcp = 1; cur_bytes = 0; cur_time = ""
			next
		}
		idx = index($0, ",")
		if (idx > 0) {
			k = substr($0, 1, idx - 1)
			v = substr($0, idx + 1)
			gsub(/^"|"$/, "", k)
			gsub(/^"|"$/, "", v)
			if (k == "Session Name") cur_name = v
			else if (k == "Client IP Address") cur_ip = v
			else if (k == "Client Host Name") cur_host = v
			else if (k == "User Name") cur_user = v
			else if (k == "Current TCP Connections") cur_tcp = v
			else if (k == "Total Transfer Bytes") { gsub(/[^0-9]/, "", v); cur_bytes = v }
			else if (k == "Connection Started at") cur_time = v
		}
	}
	END {
		if (in_item && cur_name != "") {
			if (cnt > 0) printf ","
			printf "{\"Name_str\":\"%s\",\"ClientIP_ip\":\"%s\",\"Hostname_str\":\"%s\",\"Username_str\":\"%s\",\"CurrentNumTcp_u32\":%d,\"PacketSize_u64\":%d,\"CreatedTime_dt\":\"%s\"}", cur_name, cur_ip, cur_host, cur_user, cur_tcp, cur_bytes, cur_time
		}
		print "]},\"id\":\"1\"}"
	}'
}

cmd_delete_session() {
	local hub="$1"
	local session="$2"
	run_vpncmd "$hub" "SessionDisconnect $session" >/dev/null 2>&1
	echo '{"jsonrpc":"2.0","result":{},"id":"1"}'
}

cmd_set_server_password() {
	local new_pass="$1"
	run_vpncmd "" "ServerPasswordSet $new_pass" >/dev/null 2>&1
	echo '{"jsonrpc":"2.0","result":{},"id":"1"}'
}

# ===========================================================================
# 2. JSON-RPC Fallback Engine
# ===========================================================================

rpc_call() {
	local method="$1"
	local params="${2:-}"
	[ -n "$params" ] || params='{}'
	local hub="${3:-}"

	local host
	local port
	local pass
	host=$(get_api_host)
	port=$(get_api_port)
	pass=$(get_admin_password)

	local url="https://${host}:${port}/api/"
	local payload
	payload=$(printf '{"jsonrpc":"2.0","id":"1","method":"%s","params":%s}' "$method" "$params")

	local header_hub=""
	[ -n "$hub" ] && header_hub="X-VPNADMIN-HUBNAME: $hub"

	local response
	if [ -n "$header_hub" ]; then
		response=$(curl -k -s --connect-timeout 3 -m 8 -X POST "$url" \
			-H "Content-Type: application/json" \
			-H "X-VPNADMIN-PASSWORD: ${pass}" \
			-H "$header_hub" \
			-d "$payload" 2>/dev/null)
	else
		response=$(curl -k -s --connect-timeout 3 -m 8 -X POST "$url" \
			-H "Content-Type: application/json" \
			-H "X-VPNADMIN-PASSWORD: ${pass}" \
			-d "$payload" 2>/dev/null)
	fi

	if [ -z "$response" ]; then
		echo '{"jsonrpc":"2.0","error":{"code":-32000,"message":"RPC connection failed"},"id":"1"}'
	else
		echo "$response"
	fi
}

# ===========================================================================
# 3. Unified Dispatcher Interface
# ===========================================================================

se_get_server_status() {
	if [ "$(get_api_type)" = "vpncmd" ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		cmd_get_server_status
	else
		rpc_call "GetServerStatus" "{}"
	fi
}

se_enum_hubs() {
	if [ "$(get_api_type)" = "vpncmd" ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		cmd_enum_hubs
	else
		rpc_call "EnumHub" "{}"
	fi
}

se_get_hub_status() {
	local hub="${1:-DEFAULT}"
	if [ "$(get_api_type)" = "vpncmd" ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		cmd_get_hub_status "$hub"
	else
		rpc_call "GetHubStatus" "{\"HubName_str\":\"$hub\"}"
	fi
}

se_create_hub() {
	local hub="$1"
	local pass="${2:-}"
	local online="${3:-true}"
	if [ "$(get_api_type)" = "vpncmd" ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		cmd_create_hub "$hub" "$pass" "$online"
	else
		local params
		params=$(printf '{"HubName_str":"%s","AdminPasswordPlainText_str":"%s","Online_bool":%s}' "$hub" "$pass" "$online")
		rpc_call "CreateHub" "$params"
	fi
}

se_delete_hub() {
	local hub="$1"
	if [ "$(get_api_type)" = "vpncmd" ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		cmd_delete_hub "$hub"
	else
		rpc_call "DeleteHub" "{\"HubName_str\":\"$hub\"}"
	fi
}

se_set_hub_online() {
	local hub="$1"
	local online="${2:-true}"
	if [ "$(get_api_type)" = "vpncmd" ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		cmd_set_hub_online "$hub" "$online"
	else
		rpc_call "SetHubOnline" "{\"HubName_str\":\"$hub\",\"Online_bool\":$online}"
	fi
}

se_enum_users() {
	local hub="${1:-DEFAULT}"
	if [ "$(get_api_type)" = "vpncmd" ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		cmd_enum_users "$hub"
	else
		rpc_call "EnumUser" "{\"HubName_str\":\"$hub\"}"
	fi
}

se_create_user() {
	local hub="$1"
	local user="$2"
	local pass="${3:-}"
	local realname="${4:-}"
	local note="${5:-}"
	local expire_dt="${6:-1970-01-01T00:00:00.000}"
	local max_up="${7:-0}"
	local max_down="${8:-0}"
	local multi="${9:-0}"

	if [ "$(get_api_type)" = "vpncmd" ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		cmd_create_user "$hub" "$user" "$pass" "$realname" "$note" "$expire_dt" "$max_up" "$max_down" "$multi"
	else
		local use_policy="false"
		[ "$max_up" -gt 0 ] || [ "$max_down" -gt 0 ] || [ "$multi" -gt 0 ] && use_policy="true"
		local params
		params=$(printf '{"HubName_str":"%s","Name_str":"%s","AuthType_u32":0,"Auth_Password_str":"%s","Realname_utf":"%s","Note_utf":"%s","ExpireTime_dt":"%s","UsePolicy_bool":%s,"policy:MaxUpload_u32":%d,"policy:MaxDownload_u32":%d,"policy:MultiLogins_u32":%d}' \
			"$hub" "$user" "$pass" "$realname" "$note" "$expire_dt" "$use_policy" "$max_up" "$max_down" "$multi")
		rpc_call "CreateUser" "$params"
	fi
}

se_set_user_password() {
	local hub="$1"
	local user="$2"
	local pass="$3"
	if [ "$(get_api_type)" = "vpncmd" ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		cmd_set_user_password "$hub" "$user" "$pass"
	else
		local params
		params=$(printf '{"HubName_str":"%s","Name_str":"%s","AuthType_u32":0,"Auth_Password_str":"%s"}' "$hub" "$user" "$pass")
		rpc_call "SetUser" "$params"
	fi
}

se_delete_user() {
	local hub="$1"
	local user="$2"
	if [ "$(get_api_type)" = "vpncmd" ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		cmd_delete_user "$hub" "$user"
	else
		rpc_call "DeleteUser" "{\"HubName_str\":\"$hub\",\"Name_str\":\"$user\"}"
	fi
}

se_get_secure_nat() {
	local hub="${1:-DEFAULT}"
	if [ "$(get_api_type)" = "vpncmd" ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		cmd_get_secure_nat "$hub"
	else
		rpc_call "GetSecureNATOption" "{\"RpcHubName_str\":\"$hub\"}"
	fi
}

se_set_secure_nat() {
	local hub="$1"
	local use_nat="${2:-true}"
	local use_dhcp="${3:-true}"
	local ip="${4:-192.168.30.1}"
	local mask="${5:-255.255.255.0}"
	local dhcp_start="${6:-192.168.30.10}"
	local dhcp_end="${7:-192.168.30.200}"
	local dhcp_mask="${8:-255.255.255.0}"
	local gateway="${9:-192.168.30.1}"
	local dns="${10:-192.168.30.1}"

	if [ "$(get_api_type)" = "vpncmd" ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		cmd_set_secure_nat "$hub" "$use_nat" "$use_dhcp" "$ip" "$mask" "$dhcp_start" "$dhcp_end" "$dhcp_mask" "$gateway" "$dns"
	else
		local params
		params=$(printf '{"RpcHubName_str":"%s","UseNat_bool":%s,"UseDhcp_bool":%s,"Ip_ip":"%s","Mask_ip":"%s","DhcpLeaseIPStart_ip":"%s","DhcpLeaseIPEnd_ip":"%s","DhcpSubnetMask_ip":"%s","DhcpExpireTimeSpan_u32":7200,"DhcpGatewayAddress_ip":"%s","DhcpDnsServerAddress_ip":"%s"}' \
			"$hub" "$use_nat" "$use_dhcp" "$ip" "$mask" "$dhcp_start" "$dhcp_end" "$dhcp_mask" "$gateway" "$dns")
		rpc_call "SetSecureNATOption" "$params"
	fi
}

se_enable_secure_nat() {
	local hub="${1:-DEFAULT}"
	if [ "$(get_api_type)" = "vpncmd" ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		cmd_enable_secure_nat "$hub"
	else
		rpc_call "EnableSecureNAT" "{\"HubName_str\":\"$hub\"}"
	fi
}

se_disable_secure_nat() {
	local hub="${1:-DEFAULT}"
	if [ "$(get_api_type)" = "vpncmd" ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		cmd_disable_secure_nat "$hub"
	else
		rpc_call "DisableSecureNAT" "{\"HubName_str\":\"$hub\"}"
	fi
}

se_get_ipsec() {
	if [ "$(get_api_type)" = "vpncmd" ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		cmd_get_ipsec
	else
		rpc_call "GetIPsecServices" "{}"
	fi
}

se_set_ipsec() {
	local l2tp="${1:-true}" psk="${2:-vpn}" hub="${3:-DEFAULT}"
	local raw_l2tp="${4:-false}" etherip="${5:-false}"
	if [ "$(get_api_type)" = "vpncmd" ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		cmd_set_ipsec "$l2tp" "$psk" "$hub" "$raw_l2tp" "$etherip"
	else
		local params
		params=$(printf '{"L2TP_IPsec_bool":%s,"L2TP_Raw_bool":%s,"EtherIP_IPsec_bool":%s,"IPsec_Secret_str":%s,"L2TP_DefaultHub_str":%s}' \
			"$l2tp" "$raw_l2tp" "$etherip" "$(json_string "$psk")" "$(json_string "$hub")")
		rpc_call "SetIPsecServices" "$params"
	fi
}

se_get_openvpn() {
	if [ "$(get_api_type)" = "vpncmd" ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		cmd_get_openvpn
	else
		rpc_call "GetOpenVpnSstpConfig" "{}"
	fi
}

se_set_openvpn() {
	local openvpn="${1:-true}"
	local ports="${2:-1194}"
	local sstp="${3:-false}"
	ports=$(printf '%s' "$ports" | tr ' ' ',' | tr -s ',')
	if ! printf '%s\n' "$ports" | awk -F, '{
		for (i = 1; i <= NF; i++) if ($i !~ /^[0-9]+$/ || $i < 1 || $i > 65535) exit 1
	}'; then
		api_error "OpenVPN ports must be between 1 and 65535, separated by commas or spaces." -32602
		return 1
	fi
	if [ "$(get_api_type)" = "vpncmd" ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		cmd_set_openvpn "$openvpn" "$ports" "$sstp"
	else
		local params
		params=$(printf '{"EnableOpenVPN_bool":%s,"OpenVPNPortList_str":"%s","EnableSSTP_bool":%s}' \
			"$openvpn" "$ports" "$sstp")
		rpc_call "SetOpenVpnSstpConfig" "$params"
	fi
}

se_make_openvpn_config() {
	if [ "$(get_api_type)" = "vpncmd" ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		cmd_make_openvpn_config
	else
		rpc_call "MakeOpenVpnConfigFile" "{}"
	fi
}

se_enum_sessions() {
	local hub="${1:-DEFAULT}"
	if [ "$(get_api_type)" = "vpncmd" ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		cmd_enum_sessions "$hub"
	else
		rpc_call "EnumSession" "{\"HubName_str\":\"$hub\"}"
	fi
}

se_delete_session() {
	local hub="$1"
	local session="$2"
	if [ "$(get_api_type)" = "vpncmd" ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		cmd_delete_session "$hub" "$session"
	else
		rpc_call "DeleteSession" "{\"HubName_str\":\"$hub\",\"Name_str\":\"$session\"}"
	fi
}

se_set_server_password() {
	local new_pass="$1"
	if [ "$(get_api_type)" = "vpncmd" ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		cmd_set_server_password "$new_pass"
	else
		rpc_call "SetServerPassword" "{\"PlainTextPassword_str\":\"$new_pass\"}"
	fi
}
