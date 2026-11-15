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

run_vpncmd_file() (
	hub="$1"
	command_file="$2"
	vcmd=$(find_vpncmd)
	host=$(get_api_host)
	port=$(get_api_port)
	pass=$(get_admin_password)
	set -- "${host}:${port}" /SERVER "/PASSWORD:$pass" /CSV "/IN:$command_file"
	[ -z "$hub" ] || set -- "$@" "/HUB:$hub"
	if [ -f "$vcmd" ]; then
		vcmd_dir=$(dirname "$vcmd")
		(cd "$vcmd_dir" && "$vcmd" "$@" < /dev/null 2>/dev/null)
	else
		"$vcmd" "$@" < /dev/null 2>/dev/null
	fi
)

run_vpncmd() (
	hub="$1"
	shift
	cmd="$*"
	# /IN preserves SoftEther quoting; passing a split /CMD string corrupts it.
	case "$cmd" in *[[:cntrl:]]*) return 1 ;; esac
	umask 077
	command_file=$(mktemp /tmp/softethermg-command.XXXXXX) || return 1
	trap 'rm -f "$command_file"' 0
	trap 'exit 1' HUP INT TERM
	printf '%s\n' "$cmd" > "$command_file" || return 1
	run_vpncmd_file "$hub" "$command_file"
)
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

# --- Users and groups via vpncmd ---
validate_account_name() {
	case "$1" in
		''|*[[:space:][:cntrl:]]*|*\"*|*\\*|*/*)
			api_error "Hub, user and group names must be non-empty and cannot contain whitespace, quotes, backslashes or slashes." -32602
			return 1 ;;
	esac
}

vpncmd_quote() {
	printf '"%s"' "$(printf '%s' "$1" | awk '{ gsub(/"/, "\"\""); printf "%s", $0 }')"
}

validate_account_text() {
	local value
	for value in "$@"; do
		case "$value" in
			*[[:cntrl:]]*) api_error "Account fields cannot contain control characters." -32602; return 1 ;;
		esac
	done
}

parse_account_csv() {
	awk -v kind="$1" '
		function quote(value,    result, i, c) {
			result = "\""
			for (i = 1; i <= length(value); i++) {
				c = substr(value, i, 1)
				if (c == "\\") result = result "\\\\"
				else if (c == "\"") result = result "\\\""
				else if (c in escapes) result = result escapes[c]
				else result = result c
			}
			return result "\""
		}
		function number(value) { gsub(/[^0-9]/, "", value); return value == "" ? 0 : value + 0 }
		BEGIN {
			for (i = 1; i < 32; i++) escapes[sprintf("%c", i)] = sprintf("\\u%04x", i)
			auth["Anonymous Authentication"] = 0; auth["Password Authentication"] = 1
			auth["Individual Certificate Authentication"] = 2; auth["Signed Certificate Authentication"] = 3
			auth["RADIUS Authentication"] = 4; auth["NT Domain Authentication"] = 5
		}
		{
			sub(/\r$/, "")
			for (i = 1; i <= length($0); i++) {
				c = substr($0, i, 1)
				if (c == "\"") {
					if (quoted && substr($0, i + 1, 1) == "\"") { value = value "\""; i++ }
					else quoted = !quoted
				}
				else if (c == "," && !quoted) { field[++count] = value; value = "" }
				else value = value c
			}
			if (quoted) { value = value "\n"; next }
			field[++count] = value
			if ((kind == "User" && field[1] == "User Name" && field[2] == "Full Name") ||
				(kind == "Group" && field[1] == "Group Name" && field[2] == "Full Name")) { header = 1; columns = count }
			else if (header && count == columns && ((kind == "User" && count >= 6) || (kind == "Group" && count >= 4))) {
				if (rows != "") rows = rows ","
				rows = rows "{\"Name_str\":" quote(field[1]) ",\"Realname_utf\":" quote(field[2])
				if (kind == "User") {
					group = field[3] == "-" ? "" : field[3]
					type = field[5] in auth ? auth[field[5]] : 6
					rows = rows ",\"GroupName_str\":" quote(group) ",\"Note_utf\":" quote(field[4]) ",\"AuthType_u32\":" type
					rows = rows ",\"NumLogin_u32\":" number(field[6]) ",\"TrafficBytes_u64\":" number(field[9])
				}
				else rows = rows ",\"Note_utf\":" quote(field[3]) ",\"NumUsers_u32\":" number(field[4])
				rows = rows "}"
			}
			for (key in field) delete field[key]
			count = 0; value = ""
		}
		END {
			if (!header || quoted) {
				print "{\"error\":{\"code\":-32000,\"message\":\"Unable to parse the SoftEther account list. Check the connection and vpncmd language (English).\"}}"
				exit 1
			}
			print "{\"jsonrpc\":\"2.0\",\"result\":{\"" kind "List\":[" rows "]},\"id\":\"1\"}"
		}
	'
}

cmd_enum_users() {
	local raw
	raw=$(run_vpncmd "$1" "UserList") || { api_error "Unable to read the user list."; return 1; }
	printf '%s\n' "$raw" | parse_account_csv User
}

cmd_enum_groups() {
	local raw
	raw=$(run_vpncmd "$1" "GroupList") || { api_error "Unable to read the group list."; return 1; }
	printf '%s\n' "$raw" | parse_account_csv Group
}

cmd_create_user() {
	local hub="$1" user="$2" pass="$3" realname="$4" note="$5"
	local max_up="${7:-0}" max_down="${8:-0}" multi="${9:-0}" group="${10:-none}"
	if ! run_vpncmd "$hub" "UserCreate $user /GROUP:$group /REALNAME:$(vpncmd_quote "${realname:-none}") /NOTE:$(vpncmd_quote "${note:-none}")" >/dev/null; then
		api_error "Unable to create the user. Check the name, group and administrator permissions."
		return 1
	fi
	if ! run_vpncmd "$hub" "UserPasswordSet $user /PASSWORD:$(vpncmd_quote "$pass")" >/dev/null; then
		api_error "The user was created but its password could not be set. Reset the password before using this account."
		return 1
	fi
	local policy value
	for policy in MaxUpload MaxDownload MultiLogins; do
		case "$policy" in MaxUpload) value="$max_up" ;; MaxDownload) value="$max_down" ;; MultiLogins) value="$multi" ;; esac
		if [ "$value" -gt 0 ] && ! run_vpncmd "$hub" "UserPolicySet $user /NAME:$policy /VALUE:$value" >/dev/null; then
			api_error "The user was created but its security policy could not be saved."
			return 1
		fi
	done
	echo '{"jsonrpc":"2.0","result":{},"id":"1"}'
}

cmd_set_user_password() {
	if ! run_vpncmd "$1" "UserPasswordSet $2 /PASSWORD:$(vpncmd_quote "$3")" >/dev/null; then
		api_error "Unable to reset the user password."
		return 1
	fi
	echo '{"jsonrpc":"2.0","result":{},"id":"1"}'
}

cmd_delete_user() {
	if ! run_vpncmd "$1" "UserDelete $2" >/dev/null; then
		api_error "Unable to delete the user."
		return 1
	fi
	echo '{"jsonrpc":"2.0","result":{},"id":"1"}'
}

# Read before editing so authentication, expiry and every policy field survive.
rpc_load_account() {
	local kind="$1" hub="$2" name="$3" response data error account_json record_name policy_type auth_field_type keys key wire type value
	response=$(rpc_call "Get$kind" "{\"HubName_str\":$(json_string "$hub"),\"Name_str\":$(json_string "$name")}")
	data=$(printf '%s' "$response" | jsonfilter -e '@.result')
	error=$(printf '%s' "$response" | jsonfilter -e '@.error')
	if [ -n "$error" ] || [ -z "$data" ] || [ "$data" = null ]; then
		error=$(printf '%s' "$response" | jsonfilter -e '@.error.message')
		api_error "${error:-Unable to read the existing account settings.}"
		return 1
	fi
	[ -r /usr/share/libubox/jshn.sh ] || { api_error "The OpenWrt jshn package is required to preserve existing account settings."; return 1; }
	. /usr/share/libubox/jshn.sh
	account_json=$(jshn -r "$data" 2>/dev/null) || { api_error "Unable to read the existing account settings."; return 1; }
	eval "$account_json"
	json_get_var record_name Name_str
	json_get_type policy_type UsePolicy_bool
	if [ -z "$policy_type" ]; then
		json_get_keys keys
		for key in $keys; do
			case "$key" in policy_*) api_error "Policy fields were returned without an explicit policy mode."; return 1 ;; esac
		done
		json_add_boolean UsePolicy_bool 0
		policy_type=boolean
	fi
	if [ "$record_name" != "$name" ] || [ "$policy_type" != boolean ]; then
		api_error "The server returned an incomplete account record; no changes were written."
		return 1
	fi
	if [ "$kind" = User ]; then
		json_get_type auth_field_type AuthType_u32
		if [ "$auth_field_type" != int ]; then api_error "Authentication type is missing; no changes were written."; return 1; fi
	fi
	# jshn normalizes punctuation on input; restore SoftEther wire field names.
	json_get_keys keys
	for key in $keys; do
		case "$key" in
			policy_*) wire="policy:${key#policy_}" ;;
			Recv_*) wire="Recv.${key#Recv_}" ;;
			Send_*) wire="Send.${key#Send_}" ;;
			*) continue ;;
		esac
		json_get_type type "$key"
		json_get_var value "$key"
		case "$type" in int|boolean) "json_add_$type" "$wire" "$value" ;; esac
	done
}

rpc_require_account_auth() {
	local auth_type credential
	[ "$1" = User ] || return 0
	json_get_var auth_type AuthType_u32
	case "$auth_type" in
		1) json_get_var credential HashedKey_bin ;;
		2) json_get_var credential UserX_bin ;;
		*) credential=not-required ;;
	esac
	if [ -z "$credential" ]; then api_error "Authentication data is missing; refusing to overwrite the user."; return 1; fi
}

rpc_update_account() (
	kind="$1"; hub="$2"; name="$3"; action="$4"
	rpc_load_account "$kind" "$hub" "$name" || exit 1
	if [ "$action" != password ]; then rpc_require_account_auth "$kind" || exit 1; fi
	json_add_string HubName_str "$hub"
	json_add_string Name_str "$name"
	if [ "$action" = password ]; then
		json_add_int AuthType_u32 1
		json_add_string HashedKey_bin ''
		json_add_string NtLmSecureHash_bin ''
		json_add_string Auth_Password_str "$5"
	else
		json_add_string Realname_utf "$5"
		json_add_string Note_utf "$6"
		[ "$kind" != User ] || json_add_string GroupName_str "$7"
	fi
	rpc_server_mutation "Set$kind" "$(json_dump)"
)

se_enum_groups() {
	validate_account_name "$1" || return 1
	if [ "$(get_api_type)" = vpncmd ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		cmd_enum_groups "$1"
	else
		rpc_call EnumGroup "{\"HubName_str\":$(json_string "$1")}"
	fi
}

se_save_group() {
	local hub="$1" name="$2" realname="$3" note="$4" create="$5" command
	validate_account_name "$hub" && validate_account_name "$name" && validate_account_text "$realname" "$note" || return 1
	if [ "$(get_api_type)" = vpncmd ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		[ "$create" = true ] && command=GroupCreate || command=GroupSet
		if ! run_vpncmd "$hub" "$command $name /REALNAME:$(vpncmd_quote "${realname:-none}") /NOTE:$(vpncmd_quote "${note:-none}")" >/dev/null; then
			api_error "Unable to save the group. Check the name and administrator permissions."
			return 1
		fi
		echo '{"jsonrpc":"2.0","result":{},"id":"1"}'
	elif [ "$create" = true ]; then
		rpc_call CreateGroup "{\"HubName_str\":$(json_string "$hub"),\"Name_str\":$(json_string "$name"),\"Realname_utf\":$(json_string "$realname"),\"Note_utf\":$(json_string "$note"),\"UsePolicy_bool\":false}"
	else
		rpc_update_account Group "$hub" "$name" info "$realname" "$note"
	fi
}

se_delete_group() {
	validate_account_name "$1" && validate_account_name "$2" || return 1
	if [ "$(get_api_type)" = vpncmd ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		if ! run_vpncmd "$1" "GroupDelete $2" >/dev/null; then api_error "Unable to delete the group."; return 1; fi
		echo '{"jsonrpc":"2.0","result":{},"id":"1"}'
	else
		rpc_call DeleteGroup "{\"HubName_str\":$(json_string "$1"),\"Name_str\":$(json_string "$2")}"
	fi
}

se_set_user_info() {
	local hub="$1" user="$2" realname="$3" note="$4" group="$5"
	validate_account_name "$hub" && validate_account_name "$user" && validate_account_text "$realname" "$note" || return 1
	[ -z "$group" ] || validate_account_name "$group" || return 1
	if [ "$(get_api_type)" = vpncmd ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		if ! run_vpncmd "$hub" "UserSet $user /GROUP:${group:-none} /REALNAME:$(vpncmd_quote "${realname:-none}") /NOTE:$(vpncmd_quote "${note:-none}")" >/dev/null; then
			api_error "Unable to save user details or group membership."
			return 1
		fi
		echo '{"jsonrpc":"2.0","result":{},"id":"1"}'
	else
		rpc_update_account User "$hub" "$user" info "$realname" "$note" "$group"
	fi
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
	validate_account_text "$1" || return 1
	if ! run_vpncmd "" "ServerPasswordSet $(vpncmd_quote "$1")" >/dev/null; then
		api_error "Unable to change the server administrator password."
		return 1
	fi
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
	# Keep JSON payloads, including imported private keys, out of process arguments.
	if [ -n "$header_hub" ]; then
		response=$(printf '%s' "$payload" | curl -k -s --connect-timeout 3 -m 8 -X POST "$url" \
			-H "Content-Type: application/json" \
			-H "X-VPNADMIN-PASSWORD: ${pass}" \
			-H "$header_hub" \
			-d @- 2>/dev/null)
	else
		response=$(printf '%s' "$payload" | curl -k -s --connect-timeout 3 -m 8 -X POST "$url" \
			-H "Content-Type: application/json" \
			-H "X-VPNADMIN-PASSWORD: ${pass}" \
			-d @- 2>/dev/null)
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
	validate_account_name "$hub" || return 1
	if [ "$(get_api_type)" = "vpncmd" ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		cmd_enum_users "$hub"
	else
		rpc_call "EnumUser" "{\"HubName_str\":$(json_string "$hub")}"
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
	local multi="${9:-0}" group="${10:-}"
	validate_account_name "$hub" && validate_account_name "$user" && validate_account_text "$pass" "$realname" "$note" || return 1
	[ -z "$group" ] || validate_account_name "$group" || return 1
	if [ -z "$pass" ]; then api_error "A non-empty password is required for password authentication." -32602; return 1; fi
	local value
	for value in "$max_up" "$max_down" "$multi"; do
		case "$value" in ''|*[!0-9]*) api_error "User limits must be non-negative integers." -32602; return 1 ;; esac
		if [ "${#value}" -gt 10 ] || ! awk -v value="$value" 'BEGIN { exit value > 2147483647 }'; then api_error "User limits cannot exceed 2147483647." -32602; return 1; fi
	done

	if [ "$(get_api_type)" = "vpncmd" ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		cmd_create_user "$hub" "$user" "$pass" "$realname" "$note" "$expire_dt" "$max_up" "$max_down" "$multi" "$group"
	else
		local use_policy="false"
		[ "$max_up" -gt 0 ] || [ "$max_down" -gt 0 ] || [ "$multi" -gt 0 ] && use_policy="true"
		local params
		params=$(printf '{"HubName_str":%s,"Name_str":%s,"GroupName_str":%s,"AuthType_u32":1,"Auth_Password_str":%s,"Realname_utf":%s,"Note_utf":%s,"ExpireTime_dt":%s,"UsePolicy_bool":%s,"policy:Access_bool":true,"policy:MaxConnection_u32":32,"policy:TimeOut_u32":20,"policy:Ver3_bool":true,"policy:MaxUpload_u32":%s,"policy:MaxDownload_u32":%s,"policy:MultiLogins_u32":%s}' \
			"$(json_string "$hub")" "$(json_string "$user")" "$(json_string "$group")" "$(json_string "$pass")" "$(json_string "$realname")" "$(json_string "$note")" "$(json_string "$expire_dt")" "$use_policy" "$(printf '%s' "$max_up" | awk '{printf "%.0f", $0 + 0}')" "$(printf '%s' "$max_down" | awk '{printf "%.0f", $0 + 0}')" "$(printf '%s' "$multi" | awk '{printf "%.0f", $0 + 0}')")
		rpc_call "CreateUser" "$params"
	fi
}

se_set_user_password() {
	local hub="$1"
	local user="$2"
	local pass="$3"
	validate_account_name "$hub" && validate_account_name "$user" && validate_account_text "$pass" || return 1
	if [ -z "$pass" ]; then api_error "Password cannot be empty." -32602; return 1; fi
	if [ "$(get_api_type)" = "vpncmd" ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		cmd_set_user_password "$hub" "$user" "$pass"
	else
		rpc_update_account User "$hub" "$user" password "$pass"
	fi
}

se_delete_user() {
	local hub="$1"
	local user="$2"
	validate_account_name "$hub" && validate_account_name "$user" || return 1
	if [ "$(get_api_type)" = "vpncmd" ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		cmd_delete_user "$hub" "$user"
	else
		rpc_call "DeleteUser" "{\"HubName_str\":$(json_string "$hub"),\"Name_str\":$(json_string "$user")}"
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

# --- Server listeners, certificates and configuration backup ---
validate_listener_port() {
	case "$1" in ''|*[!0-9]*) api_error "TCP port must be an integer between 1 and 65535." -32602; return 1 ;; esac
	if [ "${#1}" -gt 5 ] || ! awk -v port="$1" 'BEGIN { exit port < 1 || port > 65535 }'; then
		api_error "TCP port must be an integer between 1 and 65535." -32602
		return 1
	fi
}

rpc_server_mutation() {
	local response data error
	response=$(rpc_call "$1" "$2")
	error=$(printf '%s' "$response" | jsonfilter -e '@.error')
	data=$(printf '%s' "$response" | jsonfilter -e '@.result')
	case "$data" in \{*) ;; *) data='' ;; esac
	if [ -n "$error" ] || [ -z "$data" ]; then
		error=$(printf '%s' "$response" | jsonfilter -e '@.error.message')
		api_error "${error:-The server did not confirm the change.}"
		return 1
	fi
	# SetServerCert may echo the private key; return only an acknowledgement.
	echo '{"jsonrpc":"2.0","result":{},"id":"1"}'
}

rpc_server_file() {
	local response data error
	response=$(rpc_call "$1" '{}')
	data=$(printf '%s' "$response" | jsonfilter -e "@.result.$2")
	error=$(printf '%s' "$response" | jsonfilter -e '@.error')
	if [ -n "$error" ] || [ -z "$data" ]; then
		error=$(printf '%s' "$response" | jsonfilter -e '@.error.message')
		api_error "${error:-Unable to download the requested server file.}"
		return 1
	fi
	printf '{"jsonrpc":"2.0","result":{"%s":%s},"id":"1"}\n' "$2" "$(json_string "$data")"
}

cmd_server_file() (
	umask 077
	server_dir=$(mktemp -d /tmp/softethermg-server.XXXXXX) || { api_error "Unable to create a private temporary directory."; exit 1; }
	trap 'rm -rf "$server_dir"' 0
	trap 'exit 1' HUP INT TERM
	case "$1" in
		certificate) command=ServerCertGet; field=Cert_bin ;;
		config) command=ConfigGet; field=FileData_bin ;;
		*) exit 1 ;;
	esac
	if ! run_vpncmd "" "$command $server_dir/export" >/dev/null || [ ! -s "$server_dir/export" ]; then
		api_error "Unable to export the requested server file. Server administrator access is required."
		exit 1
	fi
	encoded=$(base64 < "$server_dir/export") || { api_error "Unable to encode the server file."; exit 1; }
	printf '{"jsonrpc":"2.0","result":{"%s":"%s"},"id":"1"}\n' "$field" "$(printf '%s' "$encoded" | tr -d '\r\n')"
)

se_enum_listeners() {
	if [ "$(get_api_type)" = vpncmd ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		local raw
		raw=$(run_vpncmd "" ListenerList) || { api_error "Unable to read TCP listeners."; return 1; }
		printf '%s\n' "$raw" | awk -F, '
			{ gsub(/\r|"/, "") }
			$1 == "Port Number" && $2 == "Status" { header = 1; next }
			header && $1 ~ /^TCP [0-9]+$/ {
				port = substr($1, 5) + 0
				if ($2 != "Listening" && $2 != "Stopped" && $2 != "Error") { invalid = 1; next }
				if (rows != "") rows = rows ","
				rows = rows "{\"Ports_u32\":" port ",\"Enables_bool\":" ($2 != "Stopped" ? "true" : "false") ",\"Errors_bool\":" ($2 == "Error" ? "true" : "false") "}"
			}
			END {
				if (!header || invalid) { print "{\"error\":{\"code\":-32000,\"message\":\"Unable to parse TCP listener status. Check the vpncmd language (English).\"}}"; exit 1 }
				print "{\"result\":{\"ListenerList\":[" rows "]}}"
			}
		'
	else
		rpc_call EnumListener '{}'
	fi
}

se_change_listener() {
	local action="$1" port="$2" enabled="${3:-true}" command method params current_port
	validate_listener_port "$port" || return 1
	current_port=$(get_api_port)
	validate_listener_port "$current_port" || return 1
	current_port=$(awk -v port="$current_port" 'BEGIN { printf "%d", port }')
	port=$(awk -v port="$port" 'BEGIN { printf "%d", port }')
	if { [ "$action" = delete ] || { [ "$action" = set ] && [ "$enabled" = false ]; }; } &&
		[ "$port" = "$current_port" ]; then
		api_error "The current management port cannot be disabled or deleted. Connect through another port in Basic Settings first." -32602
		return 1
	fi
	case "$action:$enabled" in
		create:true) command=ListenerCreate; method=CreateListener ;;
		set:true) command=ListenerEnable; method=EnableListener ;;
		set:false) command=ListenerDisable; method=EnableListener ;;
		delete:*) command=ListenerDelete; method=DeleteListener ;;
		*) api_error "Invalid listener operation." -32602; return 1 ;;
	esac
	if [ "$(get_api_type)" = vpncmd ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		if ! run_vpncmd "" "$command $port" >/dev/null; then api_error "Unable to change the TCP listener."; return 1; fi
		echo '{"result":{}}'
	else
		params=$(printf '{"Port_u32":%s,"Enable_bool":%s}' "$port" "$enabled")
		rpc_server_mutation "$method" "$params"
	fi
}

se_get_server_cert() {
	if [ "$(get_api_type)" = vpncmd ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		cmd_server_file certificate
	else
		rpc_server_file GetServerCert Cert_bin
	fi
}

validate_server_blob() {
	case "$1" in ''|*[!A-Za-z0-9+/=]*) api_error "Certificate and key must contain valid Base64 data." -32602; return 1 ;; esac
	local content="${1%=}"
	content="${content%=}"
	case "$content" in *=*) api_error "Certificate or key has invalid Base64 padding." -32602; return 1 ;; esac
	if [ "${#1}" -gt 131072 ] || [ "$((${#1} % 4))" -ne 0 ] ||
		! printf '%s' "$1" | base64 -d >/dev/null 2>&1; then
		api_error "Certificate or key is invalid or exceeds 96 KiB." -32602
		return 1
	fi
}

se_set_server_cert() {
	validate_server_blob "$1" && validate_server_blob "$2" || return 1
	if [ "$(get_api_type)" = vpncmd ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		(
			umask 077
			cert_dir=$(mktemp -d /tmp/softethermg-certificate.XXXXXX) || { api_error "Unable to create a private certificate directory."; exit 1; }
			trap 'rm -rf "$cert_dir"' 0
			trap 'exit 1' HUP INT TERM
			printf '%s' "$1" | base64 -d > "$cert_dir/server.crt" || { api_error "Unable to stage the certificate file."; exit 1; }
			printf '%s' "$2" | base64 -d > "$cert_dir/server.key" || { api_error "Unable to stage the private key file."; exit 1; }
			if ! run_vpncmd "" "ServerCertSet /LOADCERT:$cert_dir/server.crt /LOADKEY:$cert_dir/server.key" >/dev/null; then
				api_error "Unable to replace the certificate. Check that the certificate and unencrypted private key match and are supported by SoftEther."
				exit 1
			fi
			echo '{"result":{}}'
		)
	else
		rpc_server_mutation SetServerCert "{\"Cert_bin\":$(json_string "$1"),\"Key_bin\":$(json_string "$2")}"
	fi
}

se_regenerate_server_cert() {
	local name="$1"
	case "$name" in ''|*[!a-zA-Z0-9._:*-]*) api_error "Common name must be a domain name or IP address." -32602; return 1 ;; esac
	if [ "${#name}" -gt 253 ]; then api_error "Common name cannot exceed 253 characters." -32602; return 1; fi
	if [ "$(get_api_type)" = vpncmd ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		if ! run_vpncmd "" "ServerCertRegenerate $name" >/dev/null; then api_error "Unable to regenerate the server certificate."; return 1; fi
		echo '{"result":{}}'
	else
		rpc_server_mutation RegenerateServerCert "{\"StrValue_str\":$(json_string "$name")}"
	fi
}

se_backup_config() {
	if [ "$(get_api_type)" = vpncmd ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		cmd_server_file config
	else
		rpc_server_file GetConfig FileData_bin
	fi
}

se_get_policy() (
	. /usr/share/softethermg/policy.sh
	policy_get "$@"
)

se_set_policy() (
	. /usr/share/softethermg/policy.sh
	policy_set "$@"
)

se_set_server_password() {
	local new_pass="$1"
	if [ "$(get_api_type)" = "vpncmd" ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then
		cmd_set_server_password "$new_pass"
	else
		rpc_server_mutation "SetServerPassword" "{\"PlainTextPassword_str\":$(json_string "$new_pass")}"
	fi
}
