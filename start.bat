@echo off
echo Starting App...
start "" http://localhost:5902
python -m http.server 5902
