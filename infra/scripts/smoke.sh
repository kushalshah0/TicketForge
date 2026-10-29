#!/usr/bin/env bash
set -euo pipefail

public_hostname="${PUBLIC_HOSTNAME:-kushal.runs-on.dev}"
base_url="https://${public_hostname}"
curl_args=(--fail --silent --show-error --resolve "${public_hostname}:443:127.0.0.1")
email="ticketforge-smoke-$(date -u +%s)-${RANDOM}@example.test"
password="TicketForge-$(openssl rand -hex 16)"
payload="$(EMAIL="$email" PASSWORD="$password" python3 -c 'import json, os; print(json.dumps({"email": os.environ["EMAIL"], "password": os.environ["PASSWORD"], "displayName": "TicketForge smoke", "role": "customer"}))')"

registration="$(curl "${curl_args[@]}" \
  --header 'Content-Type: application/json' \
  --data-binary "$payload" \
  "$base_url/api/auth/register")"
access_token="$(printf '%s' "$registration" | python3 -c 'import json, sys; print(json.load(sys.stdin)["accessToken"])')"
profile="$(curl "${curl_args[@]}" \
  --header "Authorization: Bearer $access_token" \
  "$base_url/api/auth/me")"

EMAIL="$email" PROFILE="$profile" python3 -c 'import json, os; user = json.loads(os.environ["PROFILE"]); assert user["email"] == os.environ["EMAIL"]'

organizer_email="ticketforge-organizer-smoke-$(date -u +%s)-${RANDOM}@example.test"
organizer_payload="$(EMAIL="$organizer_email" PASSWORD="$password" python3 -c 'import json, os; print(json.dumps({"email": os.environ["EMAIL"], "password": os.environ["PASSWORD"], "displayName": "TicketForge organizer", "role": "organizer"}))')"
organizer_registration="$(curl "${curl_args[@]}" \
  --header 'Content-Type: application/json' \
  --data-binary "$organizer_payload" \
  "$base_url/api/auth/register")"
organizer_token="$(printf '%s' "$organizer_registration" | python3 -c 'import json, sys; print(json.load(sys.stdin)["accessToken"])')"
event_payload="$(python3 -c 'import datetime, json, uuid; print(json.dumps({"title":"Deployment smoke event","description":"Temporary deployment verification","venueName":"Smoke Hall","city":"Kathmandu","startsAt":(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(hours=2)).isoformat(),"tiers":[{"id":str(uuid.uuid4()),"name":"General","priceMinor":1000}],"layout":{"sections":[{"id":str(uuid.uuid4()),"name":"Floor","tierId":None,"rows":1,"seatsPerRow":10}]}}))')"
event_payload="$(EVENT_PAYLOAD="$event_payload" python3 -c 'import json, os; payload=json.loads(os.environ["EVENT_PAYLOAD"]); payload["layout"]["sections"][0]["tierId"]=payload["tiers"][0]["id"]; print(json.dumps(payload))')"
draft="$(curl "${curl_args[@]}" \
  --header 'Content-Type: application/json' \
  --header "Authorization: Bearer $organizer_token" \
  --data-binary "$event_payload" \
  "$base_url/api/events")"
event_id="$(printf '%s' "$draft" | python3 -c 'import json, sys; print(json.load(sys.stdin)["id"])')"
published="$(curl "${curl_args[@]}" \
  --request POST \
  --header "Authorization: Bearer $organizer_token" \
  "$base_url/api/events/$event_id/publish")"
printf '%s' "$published" | python3 -c 'import json, sys; assert json.load(sys.stdin)["status"] == "PUBLISHED"'
seat_count=0
for attempt in {1..15}; do
  availability_response="$(curl --silent --show-error --resolve "${public_hostname}:443:127.0.0.1" \
    --write-out $'\n%{http_code}' "$base_url/api/events/$event_id/availability")"
  availability_status="${availability_response##*$'\n'}"
  if [[ "$availability_status" == '200' ]]; then
    availability="${availability_response%$'\n'*}"
    seat_count="$(printf '%s' "$availability" | python3 -c 'import json, sys; print(sum(len(section["seats"]) for section in json.load(sys.stdin)["sections"]))')"
    [[ "$seat_count" -eq 10 ]] && break
  fi
  sleep 1
done
[[ "$seat_count" -eq 10 ]]
first_seat="$(printf '%s' "$availability" | python3 -c 'import json, sys; print(json.load(sys.stdin)["sections"][0]["seats"][0]["seatId"])')"
second_seat="$(printf '%s' "$availability" | python3 -c 'import json, sys; print(json.load(sys.stdin)["sections"][0]["seats"][1]["seatId"])')"
hold_payload="$(EVENT_ID="$event_id" SEAT_ID="$first_seat" python3 -c 'import json, os; print(json.dumps({"eventId":os.environ["EVENT_ID"],"seatIds":[os.environ["SEAT_ID"]]}))')"
hold_key="booking-smoke-${RANDOM}-$(date -u +%s)"
hold="$(curl "${curl_args[@]}" \
  --request POST \
  --header 'Content-Type: application/json' \
  --header "Authorization: Bearer $access_token" \
  --header "Idempotency-Key: $hold_key" \
  --data-binary "$hold_payload" \
  "$base_url/api/bookings")"
booking_id="$(printf '%s' "$hold" | python3 -c 'import json, sys; print(json.load(sys.stdin)["bookingId"])')"
replayed_hold="$(curl "${curl_args[@]}" \
  --request POST \
  --header 'Content-Type: application/json' \
  --header "Authorization: Bearer $access_token" \
  --header "Idempotency-Key: $hold_key" \
  --data-binary "$hold_payload" \
  "$base_url/api/bookings")"
REPLAYED="$replayed_hold" BOOKING_ID="$booking_id" python3 -c 'import json, os; assert json.loads(os.environ["REPLAYED"])["bookingId"] == os.environ["BOOKING_ID"]'
different_hold="$(EVENT_ID="$event_id" SEAT_ID="$second_seat" python3 -c 'import json, os; print(json.dumps({"eventId":os.environ["EVENT_ID"],"seatIds":[os.environ["SEAT_ID"]]}))')"
reused_status="$(curl --silent --show-error --resolve "${public_hostname}:443:127.0.0.1" \
  --request POST --output /dev/null --write-out '%{http_code}' \
  --header 'Content-Type: application/json' \
  --header "Authorization: Bearer $access_token" \
  --header "Idempotency-Key: $hold_key" \
  --data-binary "$different_hold" \
  "$base_url/api/bookings")"
[[ "$reused_status" == '422' ]]
booking_detail="$(curl "${curl_args[@]}" \
  --header "Authorization: Bearer $access_token" \
  "$base_url/api/bookings/$booking_id")"
BOOKING_ID="$booking_id" DETAIL="$booking_detail" python3 -c 'import json,os; assert json.loads(os.environ["DETAIL"])["id"] == os.environ["BOOKING_ID"]'
booking_list="$(curl "${curl_args[@]}" \
  --header "Authorization: Bearer $access_token" \
  "$base_url/api/bookings?limit=20")"
BOOKING_ID="$booking_id" LIST="$booking_list" python3 -c 'import json,os; assert any(item["id"] == os.environ["BOOKING_ID"] for item in json.loads(os.environ["LIST"]))'
cancelled_booking="$(curl "${curl_args[@]}" \
  --request POST \
  --header "Authorization: Bearer $access_token" \
  "$base_url/api/bookings/$booking_id/cancel")"
printf '%s' "$cancelled_booking" | python3 -c 'import json,sys; assert json.load(sys.stdin)["status"] == "CANCELLED"'
repeated_cancel="$(curl "${curl_args[@]}" \
  --request POST \
  --header "Authorization: Bearer $access_token" \
  "$base_url/api/bookings/$booking_id/cancel")"
printf '%s' "$repeated_cancel" | python3 -c 'import json,sys; assert json.load(sys.stdin)["status"] == "CANCELLED"'
after_cancel_availability="$(curl "${curl_args[@]}" "$base_url/api/events/$event_id/availability")"
SEAT_ID="$first_seat" AVAILABILITY="$after_cancel_availability" python3 -c 'import json,os; seats=[seat for section in json.loads(os.environ["AVAILABILITY"])["sections"] for seat in section["seats"]]; assert next(seat for seat in seats if seat["seatId"] == os.environ["SEAT_ID"])["status"] == "AVAILABLE"'
initial_browse="$(curl "${curl_args[@]}" \
  --get --data-urlencode 'q=Deployment smoke event' \
  "$base_url/api/events")"
EVENT_ID="$event_id" BROWSE="$initial_browse" python3 -c 'import json, os; assert any(event["id"] == os.environ["EVENT_ID"] for event in json.loads(os.environ["BROWSE"])["items"])'
updated="$(curl "${curl_args[@]}" \
  --request PATCH \
  --header 'Content-Type: application/json' \
  --header "Authorization: Bearer $organizer_token" \
  --data '{"title":"Updated TicketForge launch"}' \
  "$base_url/api/events/$event_id")"
printf '%s' "$updated" | python3 -c 'import json, sys; assert json.load(sys.stdin)["title"] == "Updated TicketForge launch"'
stale_browse="$(curl "${curl_args[@]}" \
  --get --data-urlencode 'q=Deployment smoke event' \
  "$base_url/api/events")"
EVENT_ID="$event_id" BROWSE="$stale_browse" python3 -c 'import json, os; assert all(event["id"] != os.environ["EVENT_ID"] for event in json.loads(os.environ["BROWSE"])["items"])'
browse="$(curl "${curl_args[@]}" \
  --get --data-urlencode 'q=Updated TicketForge launch' \
  "$base_url/api/events")"
EVENT_ID="$event_id" BROWSE="$browse" python3 -c 'import json, os; assert any(event["id"] == os.environ["EVENT_ID"] for event in json.loads(os.environ["BROWSE"])["items"])'
cancelled="$(curl "${curl_args[@]}" \
  --request POST \
  --header "Authorization: Bearer $organizer_token" \
  "$base_url/api/events/$event_id/cancel")"
printf '%s' "$cancelled" | python3 -c 'import json, sys; assert json.load(sys.stdin)["status"] == "CANCELLED"'
detail_status="$(curl --silent --show-error --resolve "${public_hostname}:443:127.0.0.1" \
  --output /dev/null --write-out '%{http_code}' "$base_url/api/events/$event_id")"
[[ "$detail_status" == '404' ]]
cancelled_browse="$(curl "${curl_args[@]}" \
  --get --data-urlencode 'q=Updated TicketForge launch' \
  "$base_url/api/events")"
EVENT_ID="$event_id" BROWSE="$cancelled_browse" python3 -c 'import json, os; assert all(event["id"] != os.environ["EVENT_ID"] for event in json.loads(os.environ["BROWSE"])["items"])'
printf 'PASS registration, profile, organizer CRUD/publish/cancel, and browse at https://%s\n' "$public_hostname"