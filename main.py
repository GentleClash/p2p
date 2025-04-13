from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from socketio import AsyncServer, ASGIApp
import os
import uuid
import json
import logging
import time
import asyncio
import random

app = FastAPI()
sio = AsyncServer(async_mode='asgi', cors_allowed_origins="*")
socket_app = ASGIApp(sio)

# Mount static files and templates
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[logging.StreamHandler()]
)
logger = logging.getLogger(__name__)

# Dictionary to store active rooms
rooms = {}
ROOMS_FILE = 'rooms.json'

def load_rooms():
    global rooms
    if os.path.exists(ROOMS_FILE):
        try:
            with open(ROOMS_FILE, 'r') as f:
                rooms.update(json.load(f))
                for room_id in list(rooms.keys()):
                    if 'peers' not in rooms[room_id]:
                        rooms[room_id]['peers'] = []
                    if 'created_at' not in rooms[room_id]:
                        rooms[room_id]['created_at'] = time.time()
                    if 'peer_data' not in rooms[room_id]:
                        rooms[room_id]['peer_data'] = []
        except json.JSONDecodeError:
            rooms = {}
            logger.warning(f"Invalid JSON in {ROOMS_FILE}, starting with empty rooms")

def save_rooms():
    rooms_to_save = {}
    for room_id, room_data in rooms.items():
        rooms_to_save[room_id] = {
            'peers': room_data.get('peers', []),
            'created_at': room_data.get('created_at', time.time()),
            'peer_data': room_data.get('peer_data', [])
        }
    with open(ROOMS_FILE, 'w') as f:
        json.dump(rooms_to_save, f)
    logger.debug(f"Saved {len(rooms)} rooms to {ROOMS_FILE}")

load_rooms()

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    """Render the main page"""
    return templates.TemplateResponse("index.html", {"request": request})

@app.post("/create-room")
async def create_room():
    room_id = str(uuid.uuid4())[:8]
    rooms[room_id] = {
        'peers': [],
        'created_at': time.time()
    }
    save_rooms()
    logger.info(f"Created room: {room_id}")
    return {"room_id": room_id}

@app.get("/join-room/{room_id}", response_class=HTMLResponse)
async def join_room(request: Request, room_id: str):
    """Join an existing room"""
    logger.info(f"Attempting to join room: {room_id}")
    if room_id not in rooms:
        logger.warning(f"Room {room_id} not found")
        return templates.TemplateResponse("error.html", {"request": request, "message": "Room not found. Please check the room code."}), 404
    try:
        logger.info(f"Rendering room.html for room: {room_id}")
        return templates.TemplateResponse("room.html", {"request": request, "room_id": room_id})
    except Exception as e:
        logger.error(f"Error rendering room.html: {str(e)}")
        return templates.TemplateResponse("error.html", {"request": request, "message": "An error occurred while loading the room."}), 500

@app.get("/status")
async def status():
    """Return health status and active rooms with peers"""
    active_rooms = []
    for room_id, room_data in rooms.items():
        active_rooms.append({
            "room_id": room_id,
            "peer_count": len(room_data.get("peers", [])),
            "peers": room_data.get("peers", []),
            "created_at": room_data.get("created_at", 0)
        })
    return {
        "status": "healthy",
        "active_rooms_count": len(rooms),
        "active_rooms": active_rooms
    }

@sio.event
async def connect(sid, environ):
    logger.info(f"Client connected: {sid}")

@sio.event
async def disconnect(sid):
    logger.info(f"Client disconnected: {sid}")
    for room_id in rooms:
        for peer_data in rooms[room_id].get('peer_data', []):
            if peer_data.get('socket_id') == sid:
                peer_id = peer_data.get('peer_id')
                if peer_id in rooms[room_id]['peers']:
                    rooms[room_id]['peers'].remove(peer_id)
                await sio.emit('peer_disconnected', {'peer_id': peer_id}, to=room_id)
                save_rooms()
                break

@sio.event
async def join_room(sid, data):
    room_id = data.get('room_id')
    peer_id = data.get('peer_id')
    
    logger.info(f"Socket {sid} joining room {room_id} as peer {peer_id}")
    
    if room_id not in rooms:
        await sio.emit('error', {'message': 'Room not found'}, to=sid)
        return
    
    if not peer_id:
        peer_id = str(uuid.uuid4())[:8]
    
    await sio.enter_room(sid, room_id)
    
    if peer_id not in rooms[room_id]['peers']:
        rooms[room_id]['peers'].append(peer_id)
    
    if 'peer_data' not in rooms[room_id]:
        rooms[room_id]['peer_data'] = []
    
    peer_found = False
    for peer_data in rooms[room_id]['peer_data']:
        if peer_data.get('peer_id') == peer_id:
            peer_data['socket_id'] = sid
            peer_data['last_seen'] = time.time()
            peer_found = True
            break
    
    if not peer_found:
        rooms[room_id]['peer_data'].append({
            'peer_id': peer_id,
            'socket_id': sid,
            'last_seen': time.time()
        })
    
    save_rooms()
    
    await sio.emit('room_peers', {'peers': rooms[room_id]['peers']}, to=room_id)
    await sio.emit('peer_joined', {'peer_id': peer_id}, to=room_id)
    await sio.emit('registered', {'peer_id': peer_id, 'peers': rooms[room_id]['peers']}, to=sid)

@sio.event
async def signal(sid, data):
    room_id = data.get('room_id')
    to_peer_id = data.get('to')
    from_peer_id = data.get('from')
    signal_data = data.get('signal')
    
    logger.info(f"Signal from {from_peer_id} to {to_peer_id} in room {room_id}")
    
    if room_id not in rooms:
        await sio.emit('error', {'message': 'Room not found'}, to=sid)
        return
    
    target_socket_id = None
    for peer_data in rooms[room_id].get('peer_data', []):
        if peer_data.get('peer_id') == to_peer_id:
            target_socket_id = peer_data.get('socket_id')
            break
    
    if target_socket_id:
        await sio.emit('signal', {
            'from': from_peer_id,
            'signal': signal_data
        }, to=target_socket_id)
    else:
        logger.warning(f"Target peer {to_peer_id} not found in room {room_id}")

@sio.event
async def file_list(sid, data):
    room_id = data.get('room_id')
    await sio.emit('file_list', data, to=room_id)

@sio.event
async def heartbeat(sid, data):
    room_id = data.get('room_id')
    peer_id = data.get('peer_id')
    
    if room_id in rooms and peer_id:
        peer_found = False
        for peer_data in rooms[room_id].get('peer_data', []):
            if peer_data.get('peer_id') == peer_id:
                peer_data['last_seen'] = time.time()
                peer_found = True
                break
        
        if not peer_found and peer_id in rooms[room_id]['peers']:
            if 'peer_data' not in rooms[room_id]:
                rooms[room_id]['peer_data'] = []
            rooms[room_id]['peer_data'].append({
                'peer_id': peer_id,
                'socket_id': sid,
                'last_seen': time.time()
            })
        
        if random.random() < 0.01:
            await cleanup_rooms()
        
        await sio.emit('active_peers', {'peers': rooms[room_id]['peers']}, to=sid)

async def cleanup_rooms():
    """Remove inactive peers and empty rooms"""
    now = time.time()
    rooms_removed = 0
    peers_removed = 0
    
    for room_id in list(rooms.keys()):
        if 'peer_data' not in rooms[room_id]:
            rooms[room_id]['peer_data'] = []
            
        disconnected_peers = []
        for peer_data in list(rooms[room_id].get('peer_data', [])):
            if now - peer_data.get('last_seen', 0) > 30:
                peer_id = peer_data.get('peer_id')
                if peer_id and peer_id in rooms[room_id]['peers']:
                    rooms[room_id]['peers'].remove(peer_id)
                    disconnected_peers.append(peer_id)
                    peers_removed += 1
                rooms[room_id]['peer_data'].remove(peer_data)
        
        for peer_id in disconnected_peers:
            await sio.emit('peer_disconnected', {'peer_id': peer_id}, to=room_id)
        
        if not rooms[room_id]['peers'] or (now - rooms[room_id].get('created_at', 0) > 3600):
            del rooms[room_id]
            rooms_removed += 1
    
    if peers_removed > 0 or rooms_removed > 0:
        logger.info(f"Cleanup: removed {peers_removed} inactive peers and {rooms_removed} empty/old rooms")
        save_rooms()
    
    return peers_removed, rooms_removed

async def schedule_cleanup():
    """Run cleanup every minute"""
    while True:
        await asyncio.sleep(60)
        try:
            await cleanup_rooms()
        except Exception as e:
            logger.error(f"Error in scheduled cleanup: {str(e)}")

from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app):
    # Startup
    logger.info("Starting server with automatic room/peer cleanup")
    load_rooms()
    asyncio.create_task(schedule_cleanup())
    yield
    # Shutdown
    logger.info("Server stopping - clearing all rooms")
    rooms.clear()
    with open(ROOMS_FILE, 'w') as f:
        json.dump({}, f)
    logger.info("Server stopped. All rooms cleared.")

app.lifespan = lifespan

app.mount("/", socket_app)