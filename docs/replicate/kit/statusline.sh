#!/bin/bash
# Status line: model | 5h limit | weekly limit | session cost. Bars turn yellow at 60%, red at 85%.
input=$(cat)
j() { jq -r "$1" <<<"$input"; }

bar() { # label, used %, reset epoch, reset date format
  local pct=$2 n i out="" color
  [ -z "$pct" ] || [ "$pct" = null ] && { printf '%s –' "$1"; return; }
  pct=${pct%.*}; n=$(( (pct + 5) / 10 )); [ $n -gt 10 ] && n=10
  if [ $pct -ge 85 ]; then color='\033[31m'; elif [ $pct -ge 60 ]; then color='\033[33m'; else color='\033[32m'; fi
  for ((i = 0; i < 10; i++)); do [ $i -lt $n ] && out+="█" || out+="░"; done
  local reset=""; [ -n "$3" ] && [ "$3" != null ] && reset=" ↻$(date -r "$3" "$4")"
  printf "%s ${color}%s\033[0m %s%%%s" "$1" "$out" "$pct" "$reset"
}

printf '%s | %s | %s | %s' "$(j '.model.display_name')" \
  "$(bar 5h "$(j '.rate_limits.five_hour.used_percentage')" "$(j '.rate_limits.five_hour.resets_at')" +%H:%M)" \
  "$(bar week "$(j '.rate_limits.seven_day.used_percentage')" "$(j '.rate_limits.seven_day.resets_at')" '+%a %H:%M')" \
  "$(LC_ALL=C printf '$%.2f' "$(j '.cost.total_cost_usd // 0')")"
