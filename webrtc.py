from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit, join_room as socket_join_room
import os
import uuid
import json
import logging
import time
import threading, random

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*")

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    filename='app.log', 
    filemode='a'          
)

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
            app.logger.warning(f"Invalid JSON in {ROOMS_FILE}, starting with empty rooms")


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
    app.logger.debug(f"Saved {len(rooms)} rooms to {ROOMS_FILE}")

load_rooms()

@app.route('/')
def index():
    """Render the main page"""
    return render_template('index.html')

@app.route('/create-room', methods=['POST'])
def create_room():
    room_id = str(uuid.uuid4())[:8]
    rooms[room_id] = {
        'peers': [],
        'created_at': time.time()
    }
    save_rooms()
    app.logger.info(f"Created room: {room_id}")
    return jsonify({'room_id': room_id})

@app.route('/join-room/<room_id>')
def join_room(room_id):
    """Join an existing room"""
    app.logger.info(f"Attempting to join room: {room_id}")
    if room_id not in rooms:
        app.logger.warning(f"Room {room_id} not found")
        return render_template('error.html', message="Room not found. Please check the room code."), 404
    try:
        app.logger.info(f"Rendering room.html for room: {room_id}")
        return render_template('room.html', room_id=room_id)
    except Exception as e:
        app.logger.error(f"Error rendering room.html: {str(e)}")
        return render_template('error.html', message="An error occurred while loading the room."), 500

# WebSocket events
@socketio.on('connect')
def handle_connect():
    app.logger.info(f"Client connected: {request.sid}")

@socketio.on('disconnect')
def handle_disconnect():
    app.logger.info(f"Client disconnected: {request.sid}")
    
    # Find and remove peer from all rooms
    for room_id in rooms:
        for peer_data in rooms[room_id].get('peer_data', []):
            if peer_data.get('socket_id') == request.sid:
                peer_id = peer_data.get('peer_id')
                if peer_id in rooms[room_id]['peers']:
                    rooms[room_id]['peers'].remove(peer_id)
                # Broadcast peer disconnection
                emit('peer_disconnected', {'peer_id': peer_id}, to=room_id)
                save_rooms()
                break

@socketio.on('join_room')
def handle_join_room(data):
    room_id = data.get('room_id')
    peer_id = data.get('peer_id')
    
    app.logger.info(f"Socket {request.sid} joining room {room_id} as peer {peer_id}")
    
    if room_id not in rooms:
        emit('error', {'message': 'Room not found'})
        return
    
    # Generate peer ID if not provided
    if not peer_id:
        peer_id = str(uuid.uuid4())[:8]
    
    # Add socket to room
    socket_join_room(room_id)
    
    # Add peer to room data
    if peer_id not in rooms[room_id]['peers']:
        rooms[room_id]['peers'].append(peer_id)
    
    # Store socket ID with peer data
    if 'peer_data' not in rooms[room_id]:
        rooms[room_id]['peer_data'] = []
    
    # Update or add peer data
    peer_found = False
    for peer_data in rooms[room_id]['peer_data']:
        if peer_data.get('peer_id') == peer_id:
            peer_data['socket_id'] = request.sid
            peer_data['last_seen'] = time.time()
            peer_found = True
            break
    
    if not peer_found:
        rooms[room_id]['peer_data'].append({
            'peer_id': peer_id,
            'socket_id': request.sid,
            'last_seen': time.time()
        })
    
    save_rooms()
    
    # Send current peers list
    emit('room_peers', {'peers': rooms[room_id]['peers']}, to=room_id)
    
    # Notify room about new peer
    emit('peer_joined', {'peer_id': peer_id}, to=room_id)
    
    # Return assigned peer ID to client
    emit('registered', {'peer_id': peer_id, 'peers': rooms[room_id]['peers']})

@socketio.on('signal')
def handle_signal(data):
    room_id = data.get('room_id')
    to_peer_id = data.get('to')
    from_peer_id = data.get('from')
    signal_data = data.get('signal')
    
    app.logger.info(f"Signal from {from_peer_id} to {to_peer_id} in room {room_id}")
    
    if room_id not in rooms:
        emit('error', {'message': 'Room not found'})
        return
    
    # Find socket ID for target peer
    target_socket_id = None
    for peer_data in rooms[room_id].get('peer_data', []):
        if peer_data.get('peer_id') == to_peer_id:
            target_socket_id = peer_data.get('socket_id')
            break
    
    if target_socket_id:
        # Forward signal to target peer
        emit('signal', {
            'from': from_peer_id,
            'signal': signal_data
        }, to=target_socket_id)
    else:
        app.logger.warning(f"Target peer {to_peer_id} not found in room {room_id}")

@socketio.on('file_list')
def handle_file_list(data):
    room_id = data.get('room_id')
    emit('file_list', data, to=room_id)

@socketio.on('heartbeat')
def handle_heartbeat(data):
    room_id = data.get('room_id')
    peer_id = data.get('peer_id')
    
    if room_id in rooms and peer_id:
        # Update last seen timestamp
        peer_found = False
        for peer_data in rooms[room_id].get('peer_data', []):
            if peer_data.get('peer_id') == peer_id:
                peer_data['last_seen'] = time.time()
                peer_found = True
                break
        
        # Add peer data if not found (should not normally happen)
        if not peer_found and peer_id in rooms[room_id]['peers']:
            if 'peer_data' not in rooms[room_id]:
                rooms[room_id]['peer_data'] = []
            rooms[room_id]['peer_data'].append({
                'peer_id': peer_id,
                'socket_id': request.sid,
                'last_seen': time.time()
            })
        
        # Occasionally run cleanup (1% chance)
        if random.random() < 0.01:
            cleanup_rooms()
        
        emit('active_peers', {'peers': rooms[room_id]['peers']})

def cleanup_rooms():
    """Remove inactive peers and empty rooms"""
    now = time.time()
    rooms_removed = 0
    peers_removed = 0
    
    for room_id in list(rooms.keys()):
        if 'peer_data' not in rooms[room_id]:
            rooms[room_id]['peer_data'] = []
            
        disconnected_peers = []
        for peer_data in list(rooms[room_id].get('peer_data', [])):
            if now - peer_data.get('last_seen', 0) > 30:  # 30 seconds timeout
                peer_id = peer_data.get('peer_id')
                if peer_id and peer_id in rooms[room_id]['peers']:
                    rooms[room_id]['peers'].remove(peer_id)
                    disconnected_peers.append(peer_id)
                    peers_removed += 1
                rooms[room_id]['peer_data'].remove(peer_data)
        
        # Notify about disconnected peers
        for peer_id in disconnected_peers:
            socketio.emit('peer_disconnected', {'peer_id': peer_id}, to=room_id)
        
        # Remove empty rooms or rooms older than 1 hour
        if not rooms[room_id]['peers'] or (now - rooms[room_id].get('created_at', 0) > 3600):
            del rooms[room_id]
            rooms_removed += 1
    
    if peers_removed > 0 or rooms_removed > 0:
        app.logger.info(f"Cleanup: removed {peers_removed} inactive peers and {rooms_removed} empty/old rooms")
        save_rooms()
    
    return peers_removed, rooms_removed


def schedule_cleanup():
    """Run cleanup every minute"""
    while True:
        time.sleep(60)  
        try:
            cleanup_rooms()
        except Exception as e:
            app.logger.error(f"Error in scheduled cleanup: {str(e)}")


if __name__ == '__main__':
    try:
        # Start background cleanup thread
        cleanup_thread = threading.Thread(target=schedule_cleanup, daemon=True)
        cleanup_thread.start()
        
        # Add a startup message with cleanup info
        app.logger.info("Starting server with automatic room/peer cleanup")
        
        socketio.run(app, host="0.0.0.0", port=5000, debug=True)

    except KeyboardInterrupt:
        app.logger.info("Server stopping - clearing all rooms")
        # Clear all rooms on shutdown
        rooms.clear()
        with open(ROOMS_FILE, 'w') as f:
            json.dump({}, f)
        app.logger.info("Server stopped by user. All rooms cleared.")

    except Exception as e:
        app.logger.error(f"Error starting server: {str(e)}")
        print(f"Error starting server: {str(e)}")