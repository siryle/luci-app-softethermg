# User/group policies. Loaded by api.sh only for policy RPC calls.
policy_schema() {
	json_set_namespace S_
	json_select ''
	json_select fields
	json_get_type policy_field_type "$1"
	[ "$policy_field_type" = object ] || { api_error "Unknown security policy field." -32602; return 1; }
	json_select "$1"
	json_get_var policy_type type
	json_get_var policy_default default
	json_get_var policy_min min
	json_get_var policy_max max
	json_get_var policy_version version
}

policy_native_record() {
	local raw
	raw=$(run_vpncmd "$policy_hub" "${1}Get $2") || { api_error "Unable to read the account security policy."; return 1; }
	printf '%s\n' "$raw" | awk -v kind="$1" -v expected="$2" '
		function quote(s,    out,i,c) {
			out="\""
			for(i=1;i<=length(s);i++) { c=substr(s,i,1); if(c=="\\") out=out "\\\\"; else if(c=="\"") out=out "\\\""; else if(c in escape) out=out escape[c]; else out=out c }
			return out "\""
		}
		BEGIN { for(i=1;i<32;i++) escape[sprintf("%c",i)]=sprintf("\\u%04x",i) }
		{
			sub(/\r$/, "")
			for(i=1;i<=length($0);i++) {
				c=substr($0,i,1)
				if(c=="\"") { if(quoted && substr($0,i+1,1)=="\"") { value=value "\""; i++ } else quoted=!quoted }
				else if(c=="," && !quoted) { field[++n]=value; value="" }
				else value=value c
			}
			if(quoted) { value=value "\n"; next }
			field[++n]=value
			if(n==2 && !table) {
				if((kind=="User" && field[1]=="User Name") || (kind=="Group" && field[1]=="Group Name")) name=field[2]
				if(kind=="User" && field[1]=="Group Name") group=field[2]
			}
			if(n==3 && field[1]=="Policy name" && field[3]=="Setting value") table=1
			else if(table && n==1 && field[1]=="") finished=1
			else if(table && !finished && n>=3) {
				key=field[1]; setting=field[n]
				if(key !~ /^[A-Za-z][A-Za-z0-9]*$/) invalid=1
				else if(setting=="Yes" || setting=="No") values=values "," quote("policy:" key "_bool") ":" (setting=="Yes"?"true":"false")
				else if(setting=="-" || setting ~ /^[0-9]+([[:space:]].*)?$/) { sub(/[^0-9].*$/, "", setting); values=values "," quote("policy:" key "_u32") ":" (setting==""?"0":sprintf("%.0f",setting+0)) }
				else invalid=1
				count++
			}
			for(key in field) delete field[key]
			n=0; value=""
		}
		END {
			if(name!=expected || quoted || invalid || (table && !count)) { print "{\"error\":{\"code\":-32000,\"message\":\"Unable to parse the account policy. Check the account and vpncmd language (English).\"}}"; exit 1 }
			print "{\"Name_str\":" quote(name) ",\"GroupName_str\":" quote(group) ",\"UsePolicy_bool\":" (table?"true":"false") values "}"
		}
	'
}

policy_load_subject() {
	local prefix="$1" kind="$2" name="$3" data
	json_set_namespace "$prefix"
	if [ "$policy_cli" -eq 1 ]; then
		data=$(policy_native_record "$kind" "$name") || { printf '%s\n' "$data"; return 1; }
		json_load "$data" || return 1
	else
		rpc_load_account "$kind" "$policy_hub" "$name" || return 1
	fi
	json_get_var policy_record_enabled UsePolicy_bool
	if [ "$policy_record_enabled" -eq 1 ]; then
		json_get_type policy_access_type policy:Access_bool
		if [ "$policy_access_type" != boolean ]; then api_error "The server returned an incomplete security policy."; return 1; fi
	fi
}

policy_init() {
	case "$1" in user) policy_kind=User ;; group) policy_kind=Group ;; *) api_error "Invalid policy subject." -32602; return 1 ;; esac
	policy_hub="$2"; policy_name="$3"
	validate_account_name "$policy_hub" && validate_account_name "$policy_name" || return 1
	[ -r /usr/share/libubox/jshn.sh ] || { api_error "The OpenWrt jshn package is required."; return 1; }
	. /usr/share/libubox/jshn.sh
	json_set_namespace S_
	json_load_file /usr/share/softethermg/policy.json || { api_error "Unable to load policy definitions."; return 1; }
	json_get_keys policy_keys fields
	policy_cli=0
	if [ "$(get_api_type)" = vpncmd ] && command -v "$(find_vpncmd)" >/dev/null 2>&1; then policy_cli=1; fi
	policy_load_subject R_ "$policy_kind" "$policy_name" || return 1
	policy_enabled="$policy_record_enabled"; policy_group=''; policy_base=''; policy_source=default
	if [ "$policy_kind" = User ]; then
		json_get_type policy_group_type GroupName_str
		[ "$policy_group_type" = string ] || { api_error "Group membership is missing; refusing to guess the inherited policy."; return 1; }
		json_get_var policy_group GroupName_str
	fi
	if [ "$policy_enabled" -eq 1 ]; then
		policy_base=R_; policy_source=own
	elif [ -n "$policy_group" ]; then
		validate_account_name "$policy_group" || return 1
		policy_load_subject G_ Group "$policy_group" || return 1
		if [ "$policy_record_enabled" -eq 1 ]; then policy_base=G_; policy_source=group; fi
	fi
	json_set_namespace T_
	json_init
	policy_supported=''
	for policy_key in $policy_keys; do
		policy_schema "$policy_key" || return 1
		policy_value="$policy_default"; policy_present=1
		if [ -n "$policy_base" ]; then
			json_set_namespace "$policy_base"
			json_get_type policy_actual_type "policy:${policy_key}_${policy_type}"
			case "$policy_type:$policy_actual_type" in
				bool:boolean|u32:int) json_get_var policy_value "policy:${policy_key}_${policy_type}" ;;
				*) policy_present=0 ;;
			esac
			if [ "$policy_present" -eq 0 ] && [ "$policy_version" -eq 2 ]; then
				api_error "The server returned an incomplete security policy; no changes were written."
				return 1
			fi
		fi
		json_set_namespace T_
		if [ "$policy_type" = bool ]; then json_add_boolean "$policy_key" "$policy_value"; else json_add_int "$policy_key" "$policy_value"; fi
		[ "$policy_present" -eq 0 ] || policy_supported="$policy_supported $policy_key"
	done
}

policy_get() {
	policy_init "$1" "$2" "$3" || return 1
	json_set_namespace O_
	json_load_file /usr/share/softethermg/policy.json || return 1
	json_add_boolean enabled "$policy_enabled"
	json_add_string source "$policy_source"
	json_add_string group "$policy_group"
	json_add_boolean atomic "$((1 - policy_cli))"
	json_add_array supported
	for policy_key in $policy_supported; do json_add_string '' "$policy_key"; done
	json_close_array
	json_add_object values
	for policy_key in $policy_keys; do
		policy_schema "$policy_key" || return 1
		json_set_namespace T_
		json_get_var policy_value "$policy_key"
		json_set_namespace O_
		if [ "$policy_type" = bool ]; then json_add_boolean "$policy_key" "$policy_value"; else json_add_int "$policy_key" "$policy_value"; fi
	done
	json_close_object
	printf '{"result":%s}\n' "$(json_dump)"
}

policy_validate_patch() {
	[ "${#1}" -le 16384 ] || { api_error "The policy patch is too large." -32602; return 1; }
	json_set_namespace P_
	policy_parsed=$(jshn -r "$1" 2>/dev/null) || { api_error "Policy values must be a JSON object." -32602; return 1; }
	eval "$policy_parsed"
	json_get_keys policy_patch_keys
	for policy_key in $policy_patch_keys; do
		policy_schema "$policy_key" || return 1
		case " $policy_supported " in *" $policy_key "*) ;; *) api_error "The server did not return this policy field; it cannot be edited." -32602; return 1 ;; esac
		json_set_namespace P_
		json_get_type policy_patch_type "$policy_key"
		json_get_var policy_value "$policy_key"
		if [ "$policy_type" = bool ]; then
			[ "$policy_patch_type" = boolean ] || { api_error "Boolean policy fields require true or false." -32602; return 1; }
		elif [ "$policy_patch_type" != int ] || ! awk -v value="$policy_value" -v min="$policy_min" -v max="$policy_max" 'BEGIN { exit value < min || value > max }'; then
			api_error "Policy value is outside the supported integer range." -32602
			return 1
		fi
		json_set_namespace T_
		if [ "$policy_type" = bool ]; then json_add_boolean "$policy_key" "$policy_value"; else json_add_int "$policy_key" "$policy_value"; fi
	done
}

policy_verify_native() {
	local expected_enabled="$1" keys="$2" expected_access="$3" key expected actual actual_type actual_enabled
	policy_load_subject V_ "$policy_kind" "$policy_name" || return 1
	json_get_var actual_enabled UsePolicy_bool
	[ "$actual_enabled" -eq "$expected_enabled" ] || { api_error "The server did not apply the policy mode."; return 1; }
	[ "$expected_enabled" -eq 1 ] || return 0
	for key in $keys; do
		policy_schema "$key" || return 1
		json_set_namespace T_
		json_get_var expected "$key"
		[ "$key" != Access ] || expected="$expected_access"
		json_set_namespace V_
		json_get_type actual_type "policy:${key}_${policy_type}"
		json_get_var actual "policy:${key}_${policy_type}"
		if [ -z "$actual_type" ] || [ "$actual" != "$expected" ]; then
			api_error "Some policy changes were not applied. Read back the actual policy before retrying."
			return 1
		fi
	done
}

policy_write_native() (
	umask 077
	policy_dir=$(mktemp -d /tmp/softethermg-policy.XXXXXX) || { api_error "Unable to create a private policy directory."; exit 1; }
	trap 'rm -rf "$policy_dir"' 0
	trap 'exit 1' HUP INT TERM
	if [ "$policy_requested" -eq 0 ]; then
		run_vpncmd "$policy_hub" "${policy_kind}PolicyRemove $policy_name" >/dev/null || { api_error "Unable to remove the independent policy."; exit 1; }
		policy_verify_native 0 '' 0 || exit 1
	else
		if [ "$policy_enabled" -eq 0 ] && [ "$policy_base" = G_ ]; then
			json_set_namespace G_
			json_get_keys policy_inherited_keys
			for policy_inherited_key in $policy_inherited_keys; do
				case "$policy_inherited_key" in policy_Ver3_bool) continue ;; policy_*_bool|policy_*_u32) ;; *) continue ;; esac
				policy_inherited_name="${policy_inherited_key#policy_}"
				policy_inherited_name="${policy_inherited_name%_*}"
				case " $policy_keys " in *" $policy_inherited_name "*) ;; *) api_error "The group contains newer policy fields that vpncmd cannot copy safely. Use JSON-RPC or keep inheriting the group policy."; exit 1 ;; esac
			done
		fi
		json_set_namespace T_
		json_get_var policy_target_access Access
		policy_check_keys="$policy_patch_keys"
		[ "$policy_enabled" -eq 1 ] || policy_check_keys="$policy_supported"
		# Native writes are incremental. Confirm denial before seeding a new
		# policy, then enable access only after every field has been read back.
		policy_deny=0
		case " $policy_patch_keys " in *' Access '*) [ "$policy_target_access" -ne 0 ] || policy_deny=1 ;; esac
		if [ "$policy_enabled" -eq 0 ] || [ "$policy_deny" -eq 1 ]; then
			run_vpncmd "$policy_hub" "${policy_kind}PolicySet $policy_name /NAME:Access /VALUE:0" >/dev/null || { api_error "Unable to prepare the policy update."; exit 1; }
			policy_verify_native 1 Access 0 || exit 1
			policy_phase_access=0
		else
			json_set_namespace R_; json_get_var policy_phase_access policy:Access_bool
		fi
		for policy_key in $policy_check_keys; do
			[ "$policy_key" != Access ] || continue
			policy_schema "$policy_key" || exit 1
			json_set_namespace T_
			json_get_var policy_value "$policy_key"
			if [ "$policy_enabled" -eq 0 ] && [ "$policy_value" = "$policy_default" ]; then continue; fi
			printf '%sPolicySet %s /NAME:%s /VALUE:%s\n' "$policy_kind" "$policy_name" "$policy_key" "$policy_value" >> "$policy_dir/commands"
		done
		if [ -s "$policy_dir/commands" ]; then
			if ! run_vpncmd_file "$policy_hub" "$policy_dir/commands" >/dev/null; then api_error "Policy update failed; some fields may already have changed. Reload the actual policy."; exit 1; fi
		fi
		policy_verify_native 1 "$policy_check_keys Access" "$policy_phase_access" || exit 1
		if [ "$policy_phase_access" != "$policy_target_access" ]; then
			run_vpncmd "$policy_hub" "${policy_kind}PolicySet $policy_name /NAME:Access /VALUE:$policy_target_access" >/dev/null || { api_error "Unable to apply the access policy. Reload the actual state."; exit 1; }
		fi
		policy_verify_native 1 "$policy_check_keys Access" "$policy_target_access" || exit 1
	fi
	echo '{"result":{}}'
)

policy_write_rpc() {
	local key wire value type
	json_set_namespace R_
	rpc_require_account_auth "$policy_kind" || return 1
	if [ "$policy_requested" -eq 1 ]; then
		if [ "$policy_enabled" -eq 0 ] && [ "$policy_base" = G_ ]; then
			json_set_namespace G_
			json_get_keys policy_group_keys
			for key in $policy_group_keys; do
				case "$key" in policy_*) wire="policy:${key#policy_}" ;; *) continue ;; esac
				json_set_namespace G_; json_get_type type "$key"; json_get_var value "$key"
				json_set_namespace R_
				case "$type" in int|boolean) "json_add_$type" "$wire" "$value" ;; esac
			done
		fi
		policy_write_keys="$policy_patch_keys"
		[ "$policy_enabled" -eq 1 ] || policy_write_keys="$policy_supported"
		for policy_key in $policy_write_keys; do
			policy_schema "$policy_key" || return 1
			json_set_namespace T_; json_get_var policy_value "$policy_key"
			json_set_namespace R_
			if [ "$policy_type" = bool ]; then json_add_boolean "policy:${policy_key}_bool" "$policy_value"; else json_add_int "policy:${policy_key}_u32" "$policy_value"; fi
			[ "$policy_version" -lt 3 ] || json_add_boolean policy:Ver3_bool 1
		done
	fi
	json_set_namespace R_
	json_add_boolean UsePolicy_bool "$policy_requested"
	json_add_string HubName_str "$policy_hub"
	json_add_string Name_str "$policy_name"
	rpc_server_mutation "Set$policy_kind" "$(json_dump)"
}

policy_set() {
	case "$4" in true) policy_requested=1 ;; false) policy_requested=0 ;; *) api_error "Policy mode must be a boolean." -32602; return 1 ;; esac
	policy_init "$1" "$2" "$3" || return 1
	policy_validate_patch "$5" || return 1
	if [ "$policy_requested" -eq 0 ] && [ -n "$policy_patch_keys" ]; then api_error "Disable the policy without editing individual values." -32602; return 1; fi
	if [ "$policy_cli" -eq 1 ]; then policy_write_native; else policy_write_rpc; fi
}
