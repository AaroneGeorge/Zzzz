#!/bin/bash
# contact.sh <video.mp4> <out.png> <t1> <t2> ... : still frames tiled 3 per row (640x360 each)
set -e
V=$1; OUT=$2; shift 2
T=$(mktemp -d)
i=0
for t in "$@"; do ffmpeg -loglevel error -y -ss "$t" -i "$V" -frames:v 1 -vf scale=640:360 "$T/c$(printf %02d $i).png"; i=$((i+1)); done
rows=$(( (i + 2) / 3 ))
ffmpeg -loglevel error -y -framerate 1 -i "$T/c%02d.png" -vf "tile=3x${rows}:padding=6:color=0x222222" -frames:v 1 "$OUT"
rm -rf "$T"
