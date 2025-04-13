import json
import time
import random
import statistics
import argparse
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
import threading
import os
import concurrent.futures

class WebRTCBenchmark:
    def __init__(self, base_url='http://localhost:5000', num_rooms=2, peers_per_room=3, 
                 file_sizes=None, iterations=3, headless=True, 
                 test_reconnection=False, test_large_files=False, test_signaling=False):
        self.base_url = base_url
        self.num_rooms = num_rooms
        self.peers_per_room = peers_per_room
        # Add file sizes for testing large file transfers if requested
        self.file_sizes = file_sizes or [5*1024*1024, 50*1024*1024]  # 5MB, 50MB
        if test_large_files:
            self.file_sizes.extend([100*1024*1024, 500*1024*1024])  # 100MB, 500MB
        self.iterations = iterations
        self.headless = headless
        self.rooms = []
        self.results = []
        self.connection_results = []
        self.reconnection_results = []
        self.signaling_results = []
        self.enable_test_reconnection = test_reconnection
        self.test_large_files = test_large_files
        self.test_signaling = test_signaling
        
        # Create test files of different sizes
        self.test_files = self.create_test_files()
        
    def create_test_files(self):
        """Create test files of different sizes with improved reliability"""
        test_files = {}
        
        for size in self.file_sizes:
            size_kb = size / 1024
            size_mb = size_kb / 1024
            size_gb = size_mb / 1024
            
            if size_gb >= 1:
                file_name = f"test_file_{int(size_gb)}GB.txt"
            elif size_mb >= 1:
                file_name = f"test_file_{int(size_mb)}MB.txt"
            else:
                file_name = f"test_file_{int(size_kb)}KB.txt"
                
            file_path = os.path.join(os.getcwd(), file_name)
            
            # Skip large file creation if it already exists to save time
            if size > 50*1024*1024 and os.path.exists(file_path):  # >50MB
                actual_size = os.path.getsize(file_path)
                print(f"Using existing large test file: {file_name} ({actual_size} bytes)")
                if abs(actual_size - size) > 1024:  # Allow 1KB tolerance
                    print(f"Warning: File size mismatch. Expected {size} bytes, got {actual_size} bytes")
                test_files[size] = file_path
                continue
                
            # Create file if it doesn't exist
            if not os.path.exists(file_path) or os.path.getsize(file_path) != size:
                print(f"Creating test file: {file_name} ({size_kb:.1f} KB)")
                
                if size > 500*1024*1024:  # For files >500MB
                    # Use a more efficient approach for very large files
                    with open(file_path, 'wb') as f:
                        # Write in 10MB chunks to avoid memory issues
                        chunk_size = 10*1024*1024
                        remaining = size
                        while remaining > 0:
                            write_size = min(chunk_size, remaining)
                            f.write(os.urandom(write_size))
                            remaining -= write_size
                            if size > 1024*1024*1024:  # Show progress for GB+ files
                                print(f"  Progress: {((size-remaining)/size)*100:.1f}% ({size-remaining} / {size} bytes)")
                else:
                    # Standard approach for smaller files
                    with open(file_path, 'w') as f:
                        # Generate random content
                        chunk = ''.join(random.choice('abcdefghijklmnopqrstuvwxyz0123456789') for _ in range(1024))
                        chunks_needed = int(size // 1024)
                        for _ in range(chunks_needed):
                            f.write(chunk)
                        # Add remaining bytes if any
                        remaining = size % 1024
                        if remaining:
                            f.write(chunk[:remaining])
            
            # Verify the file exists and is the correct size
            if os.path.exists(file_path):
                actual_size = os.path.getsize(file_path)
                print(f"Verified test file: {file_name} ({actual_size} bytes)")
                if abs(actual_size - size) > 1024:  # Allow 1KB tolerance
                    print(f"Warning: File size mismatch. Expected {size} bytes, got {actual_size} bytes")
            else:
                print(f"Error: Failed to create test file {file_name}")
                        
            test_files[size] = file_path
            
        return test_files
        
    def setup_driver(self, profile_dir=None, window_position=None):
        """Set up a Chrome WebDriver with appropriate options"""
        chrome_options = Options()
        if self.headless:
            chrome_options.add_argument("--headless=new")  # Using newer headless mode
        
        # Set window position if specified (for non-headless mode)
        if window_position and not self.headless:
            chrome_options.add_argument(f"--window-position={window_position[0]},{window_position[1]}")
        
        chrome_options.add_argument("--window-size=1280,720")  # Smaller window size
        chrome_options.add_argument("--no-sandbox")
        chrome_options.add_argument("--disable-dev-shm-usage")
        
        # Increase timeouts for large file transfers
        if self.test_large_files:
            chrome_options.add_argument("--browser-process-type=utility")
            chrome_options.add_argument("--disable-features=ScriptStreaming")
            chrome_options.add_experimental_option("prefs", {
                "download.prompt_for_download": False,
                "download.directory_upgrade": True,
                "download.default_directory": os.getcwd(),
                "profile.default_content_setting_values.automatic_downloads": 1,
                "browser.download.manager.showWhenStarting": False
            })
        
        # Use a separate user data directory for each instance to ensure isolation
        if profile_dir:
            user_data_dir = os.path.join(os.getcwd(), "chrome_profiles", profile_dir)
            os.makedirs(user_data_dir, exist_ok=True)
            chrome_options.add_argument(f"--user-data-dir={user_data_dir}")
        
        # Setup Chrome with WebDriver Manager (auto-downloads appropriate driver)
        service = Service(ChromeDriverManager().install())
        driver = webdriver.Chrome(service=service, options=chrome_options)
        
        # Increase timeout for large file transfers
        if self.test_large_files:
            driver.set_page_load_timeout(300)  # 5 minutes
            driver.set_script_timeout(300)     # 5 minutes
            
        return driver
    
    def create_room(self):
        """Create a new room and return its ID"""
        driver = self.setup_driver(profile_dir="room_creator")
        try:
            # Measure connection start time for signaling latency
            conn_start_time = time.time()
            driver.get(self.base_url)
            
            # Wait for page to load and click create room button
            create_btn = WebDriverWait(driver, 10).until(
                EC.element_to_be_clickable((By.ID, "createRoomBtn"))
            )
            create_btn_click_time = time.time()
            create_btn.click()
            
            # Wait for room to be created and extract room ID from URL
            WebDriverWait(driver, 10).until(
                EC.url_contains("/join-room/")
            )
            
            # Extract room ID from URL
            room_url = driver.current_url
            room_id = room_url.split("/")[-1]
            
            # Calculate signaling latency
            room_created_time = time.time()
            initial_load_time = create_btn_click_time - conn_start_time
            signaling_latency = room_created_time - create_btn_click_time
            
            if self.test_signaling:
                self.signaling_results.append({
                    'operation': 'create_room',
                    'initial_load_time': initial_load_time,
                    'signaling_latency': signaling_latency,
                    'room_id': room_id
                })
            
            return room_id, driver
        except Exception as e:
            print(f"Error creating room: {e}")
            driver.quit()
            return None, None
    
    def join_room(self, room_id, peer_index):
        """Join an existing room with improved reliability and measuring connection times"""
        # Create unique profile directory and window position for this peer
        profile_dir = f"peer_{room_id}_{peer_index}"
        
        # Position browsers in a grid if not headless
        if not self.headless:
            col = peer_index % 3
            row = peer_index // 3
            window_position = (col * 450, row * 400)
        else:
            window_position = None
            
        driver = self.setup_driver(profile_dir=profile_dir, window_position=window_position)
        try:
            # Measure connection times for signaling metrics
            conn_start_time = time.time()
            driver.get(f"{self.base_url}/join-room/{room_id}")
            page_load_time = time.time()
            
            # Wait for room to load
            WebDriverWait(driver, 10).until(  
                EC.presence_of_element_located((By.ID, "status"))
            )
            
            # Record "Connecting" status time
            try:
                connecting_element = WebDriverWait(driver, 5).until(
                    EC.presence_of_element_located((By.ID, "status"))
                )
                connecting_time = time.time()
                connecting_status = connecting_element.text
            except:
                connecting_time = page_load_time
                connecting_status = "Unknown"
            
            # Wait for connection status
            connection_start = time.time()
            WebDriverWait(driver, 10).until(  
                EC.text_to_be_present_in_element((By.ID, "status"), "Connected")
            )
            connection_established_time = time.time()
            
            # Calculate connection metrics
            page_load_latency = page_load_time - conn_start_time
            signaling_latency = connecting_time - page_load_time 
            connection_time = connection_established_time - connection_start
            total_connection_time = connection_established_time - conn_start_time
            
            # Wait for the peers list to be populated
            peers_list_start = time.time()
            WebDriverWait(driver, 10).until(  
                EC.presence_of_element_located((By.ID, "peersList"))
            )
            peers_list_time = time.time() - peers_list_start
            
            # Record connection metrics
            if self.test_signaling:
                self.connection_results.append({
                    'room_id': room_id,
                    'peer_index': peer_index,
                    'page_load_latency': page_load_latency,
                    'signaling_latency': signaling_latency,
                    'connection_time': connection_time,
                    'total_connection_time': total_connection_time,
                    'peers_list_time': peers_list_time,
                    'connecting_status': connecting_status
                })
            
            # Try to get peer ID from page elements
            try:
                # First, try to extract our own peer ID
                peer_elements = driver.find_elements(By.CSS_SELECTOR, "#peersList .peer-item div:nth-child(2)")
                for element in peer_elements:
                    text = element.text
                    if text.startswith("Peer "):
                        peer_id = text.split(" ")[1]
                        break
            except Exception as e:
                print(f"Error extracting peer ID: {e}")
                peer_id = f"peer_{peer_index}"  
                
            return driver, peer_id
        except Exception as e:
            print(f"Error joining room {room_id} with peer {peer_index}: {e}")
            driver.quit()
            return None, None
    
    def wait_for_transfer_completion(self, driver, file_size):
        """Wait for file transfer to complete"""
        try:
            # Wait for file to become available in the file list
            WebDriverWait(driver, 10).until(
                EC.presence_of_element_located((By.CSS_SELECTOR, "ul.file-list button.download-btn"))
            )
            
            # Click the download button to start the transfer
            download_btn = driver.find_element(By.CSS_SELECTOR, "ul.file-list button.download-btn")
            download_btn.click()
            
            # Calculate a reasonable timeout based on file size (larger files need more time)
            timeout_seconds = max(120, file_size / (1024 * 1024) * 5)  # 5 seconds per MB, minimum 2 minutes
            
            # Wait for download to complete - when status shows 100%
            WebDriverWait(driver, timeout_seconds).until(
                EC.text_to_be_present_in_element((By.CSS_SELECTOR, "span.file-status"), "99%")
            )
            
            # Wait a moment for the file to be fully processed
            time.sleep(1)
            
            return True
        except Exception as e:
            print(f"Error waiting for transfer completion: {e}")
            return None
    
    def perform_file_transfer(self, sender, receiver, file_path, file_size):
        """Perform a file transfer between two peers with support for specific UI elements"""
        try:
            # Ensure file input is visible and interactable
            sender.execute_script("""
                const fileInput = document.getElementById('fileInput');
                if (fileInput) {
                    fileInput.style.display = 'block';
                    fileInput.style.opacity = '1';
                    fileInput.style.visibility = 'visible';
                }
            """)
            
            # Get the absolute path of the file
            absolute_file_path = os.path.abspath(file_path)
            print(f"Uploading file: {absolute_file_path}")
            
            # Wait for file input to be properly visible and interactable
            file_input = WebDriverWait(sender, 20).until(
                EC.element_to_be_clickable((By.ID, "fileInput"))
            )
            
            # Clear any previous file selection
            sender.execute_script("document.getElementById('fileInput').value = '';")
            time.sleep(1)  # Small delay after clearing
            
            # Send the file path to the input element
            file_input.send_keys(absolute_file_path)
            print("File selected for upload")
            
            # Measure start time
            start_time = time.time()
            
            # Check if file appears in receiver's file list
            print("Waiting for file to appear in receiver's file list...")
            
            # For large files, extend timeout proportional to file size
            timeout_seconds = max(60, file_size / (1024 * 1024) * 2)  # 2 seconds per MB, minimum 1 minute
            
            try:
                # Wait for a new file item to appear in the file list
                WebDriverWait(receiver, timeout_seconds).until(
                    EC.presence_of_element_located((By.CSS_SELECTOR, ".file-item"))
                )
                
                # Wait for any download button to be clickable
                download_btns = WebDriverWait(receiver, timeout_seconds).until(
                    EC.presence_of_all_elements_located((By.CSS_SELECTOR, ".download-btn"))
                )
                
                # Find the first button that says "Download" (not "Save" or "Saved")
                download_btn = None
                for btn in download_btns:
                    if btn.get_attribute("tagName") == "BUTTON" and btn.text.strip() == "Download":
                        download_btn = btn
                        break
                
                if not download_btn:
                    print("Warning: Could not find a 'Download' button, trying the first download button")
                    for btn in download_btns:
                        if btn.is_enabled() and btn.is_displayed():
                            download_btn = btn
                            break
                
                if not download_btn:
                    print("Error: No download button found")
                    return None
                    
                print("Download button found, clicking...")
                download_btn.click()
                
                # Wait for transfer status to start showing progress
                # Looking for status text that contains a percentage
                WebDriverWait(receiver, timeout_seconds).until(
                    lambda driver: any('%' in elem.text for elem in 
                                    driver.find_elements(By.CSS_SELECTOR, ".file-status"))
                )
                
                # Wait for download to complete - when status shows 100% or "Complete"
                status_complete = False
                # Set longer timeout for large files
                max_timeout = max(120, file_size / (1024 * 1024) * 10)  # 10 seconds per MB, minimum 2 minutes
                timeout = time.time() + max_timeout
                
                # Get initial status for progress tracking
                last_status_update = time.time()
                last_percentage = "0%"
                
                while not status_complete and time.time() < timeout:
                    status_elements = receiver.find_elements(By.CSS_SELECTOR, ".file-status")
                    for status in status_elements:
                        text = status.text
                        # Output progress updates for large files
                        if file_size > 50*1024*1024 and '%' in text and text != last_percentage:
                            if time.time() - last_status_update > 5:  # Limit updates to every 5 seconds
                                print(f"Transfer progress: {text}")
                                last_percentage = text
                                last_status_update = time.time()
                                
                        if "Complete" in text or "Saved" in text or "99%" in text or "100%" in text:
                            status_complete = True
                            break
                    if not status_complete:
                        time.sleep(1)  # Check every second
                
                # Make sure the transfer is really complete by checking for Save button
                try:
                    WebDriverWait(receiver, 10).until(
                        lambda driver: any(btn.text in ["Save", "Saved"] 
                                        for btn in driver.find_elements(By.CSS_SELECTOR, ".download-btn"))
                    )
                except:
                    print("Warning: 'Save' button not found, but transfer may be complete")
                    
                if not status_complete:
                    print("Timed out waiting for download to complete")
                    return None
                    
                print("File transfer completed successfully")
                
                # Measure end time
                end_time = time.time()
                transfer_time = end_time - start_time
                
                # Calculate transfer rate
                transfer_rate = file_size / transfer_time / (1024 * 1024)  # MB/s
                
                return {
                    'file_size': file_size,
                    'transfer_time': transfer_time,
                    'transfer_rate': transfer_rate
                }
            except Exception as e:
                print(f"Error during file transfer on receiver side: {e}")
                return None
        except Exception as e:
            print(f"Error during file transfer on sender side: {e}")
            return None
    
    def test_reconnection(self, driver, peer_id, room_id):
        """Test reconnection by simulating network interruption"""
        try:
            print(f"Testing reconnection for peer {peer_id} in room {room_id}")
            
            # Get current connection status
            status_element = driver.find_element(By.ID, "status")
            initial_status = status_element.text
            
            if initial_status != "Connected":
                print(f"Peer {peer_id} isn't connected (status: {initial_status}). Skipping reconnection test.")
                return None
                
            # Simulate disconnection by running JavaScript code
            print(f"Simulating disconnect for peer {peer_id}...")
            disconnect_time = time.time()
            
            # Execute disconnect logic - this will vary based on your app's structure
            driver.execute_script("""
                // Disconnect WebRTC connections - adapt this to your specific implementation
                if (window.rtcPeerConnections) {
                    Object.values(window.rtcPeerConnections).forEach(conn => {
                        if (conn && conn.close) conn.close();
                    });
                }
                
                // Force disconnect WebSocket - adapt this to your specific implementation
                if (window.signalSocket && window.signalSocket.close) {
                    window.signalSocket.close();
                }
                
                // Update status to show we're disconnected
                const statusEl = document.getElementById('status');
                if (statusEl) statusEl.textContent = 'Disconnected';
                
                console.log('Disconnected by benchmark test');
            """)
            
            # Wait for status to update to show disconnection
            try:
                WebDriverWait(driver, 5).until(
                    lambda d: d.find_element(By.ID, "status").text in ["Disconnected", "Reconnecting"]
                )
                disconnect_confirmed_time = time.time()
            except:
                print("Warning: Disconnect may not have worked, status didn't change")
                disconnect_confirmed_time = disconnect_time
            
            # Wait for automatic reconnection
            reconnection_start_time = time.time()
            try:
                WebDriverWait(driver, 30).until(
                    EC.text_to_be_present_in_element((By.ID, "status"), "Connected")
                )
                reconnection_complete_time = time.time()
                reconnection_success = True
                
                # Wait for peer list to repopulate
                try:
                    WebDriverWait(driver, 10).until(
                        EC.presence_of_element_located((By.CSS_SELECTOR, "#peersList .peer-item"))
                    )
                    peers_repopulated = True
                except:
                    peers_repopulated = False
                
            except:
                reconnection_complete_time = time.time()
                reconnection_success = False
            
            # Calculate metrics
            disconnect_time_ms = (disconnect_confirmed_time - disconnect_time) * 1000
            reconnection_time_ms = (reconnection_complete_time - reconnection_start_time) * 1000
            
            reconnection_result = {
                'peer_id': peer_id,
                'room_id': room_id,
                'initial_status': initial_status,
                'disconnect_time_ms': disconnect_time_ms,
                'reconnection_time_ms': reconnection_time_ms,
                'reconnection_success': reconnection_success,
                'peers_repopulated': peers_repopulated if reconnection_success else False,
                'final_status': driver.find_element(By.ID, "status").text
            }
            
            self.reconnection_results.append(reconnection_result)
            
            return reconnection_result
            
        except Exception as e:
            print(f"Error testing reconnection for peer {peer_id}: {e}")
            return None
    
    def run_benchmark_for_room(self, room_id):
        """Run benchmark for a single room with multiple peers using threading"""
        peers = []
        threads = []
        peer_lock = threading.Lock()  # Lock for thread-safe appending to peers list
        
        def join_room_thread(i):
            """Thread function to join a room"""
            print(f"Starting thread for peer {i+1}/{self.peers_per_room} to join room {room_id}")
            peer_driver, peer_id = self.join_room(room_id, i)
            
            # Add connection timeout check
            if peer_driver:
                # Check if connection is established within 2 seconds
                try:
                    WebDriverWait(peer_driver, 2).until(
                        EC.text_to_be_present_in_element((By.ID, "status"), "Connected")
                    )
                except:
                    print(f"Peer {i+1} connection taking too long, refreshing...")
                    if not self.refresh_peer(peer_driver):
                        print(f"Refresh failed for peer {i+1}, continuing anyway")
                
                with peer_lock:
                    peers.append((peer_driver, peer_id))
                print(f"Peer {i+1} ({peer_id}) joined room {room_id}")
            else:
                print(f"Failed to join room {room_id} with peer {i+1}")
        # Start threads for joining room
        for i in range(self.peers_per_room):
            thread = threading.Thread(target=join_room_thread, args=(i,))
            threads.append(thread)
            thread.start()
        
        # Wait for all threads to complete
        for thread in threads:
            thread.join()
        
        # Verify we have at least 2 peers for testing
        if len(peers) < 2:
            print(f"Not enough peers joined room {room_id} for testing. Aborting.")
            for driver, _ in peers:
                try:
                    driver.quit()
                except:
                    pass
            return []
        
        # Wait for all connections to stabilize
        print(f"All peers joined room {room_id}, waiting for connections to stabilize...")
        time.sleep(3)
        
        # Test reconnection if requested
        if self.enable_test_reconnection:
            print("Testing reconnection capability...")
            for i, (peer_driver, peer_id) in enumerate(peers):
                # Skip testing the first peer (to keep at least one stable connection)
                if i == 0:
                    continue
                    
                # Test every other peer for reconnection
                if i % 2 == 1 or i == len(peers) - 1:
                    reconnection_result = self.test_reconnection(peer_driver, peer_id, room_id)
                    if reconnection_result and reconnection_result['reconnection_success']:
                        print(f"Peer {peer_id} successfully reconnected in {reconnection_result['reconnection_time_ms']:.2f}ms")
                    else:
                        print(f"Peer {peer_id} failed to reconnect properly")
                        
            # Wait for a moment after reconnection tests
            time.sleep(3)
        
        # Run transfer tests between peers
        room_results = []
        try:
            # For each sender-receiver pair
            for i in range(len(peers)):
                for j in range(len(peers)):
                    if i != j:  # Don't transfer to self
                        sender_driver, sender_id = peers[i]
                        receiver_driver, receiver_id = peers[j]
                        
                        print(f"Testing transfers from peer {sender_id} to peer {receiver_id}")
                        
                        # For each file size
                        for size in self.file_sizes:
                            size_label = f"{size/1024/1024:.2f} MB" if size >= 1024*1024 else f"{size/1024:.2f} KB"
                            print(f"  - Transferring {size_label} file...")
                            
                            # For very large files, do fewer iterations
                            actual_iterations = 1 if size > 100*1024*1024 else self.iterations
                            
                            # Run multiple iterations for more reliable results
                            iteration_results = []
                            for iteration in range(actual_iterations):
                                result = self.perform_file_transfer(
                                    sender_driver, receiver_driver, 
                                    self.test_files[size], size
                                )
                                if result:
                                    result['sender'] = sender_id
                                    result['receiver'] = receiver_id
                                    result['room_id'] = room_id
                                    result['iteration'] = iteration + 1
                                    iteration_results.append(result)
                                    print(f"    Iteration {iteration+1}: {result['transfer_rate']:.2f} MB/s")
                                    
                                    # Clear previous file or wait for UI reset
                                    # Use longer delay for larger files
                                    reset_delay = max(5, size / (5*1024*1024))
                                    time.sleep(reset_delay)  # Increased delay for larger files
                                else:
                                    print(f"    Iteration {iteration+1}: Failed")
                            
                            # Add all iteration results
                            room_results.extend(iteration_results)
        finally:
            # Close all browser windows
            for driver, _ in peers:
                try:
                    driver.quit()
                except:
                    pass
                
        return room_results
    
    def test_signaling_latency(self, concurrent_users=10):
        """Test signaling server latency with concurrent connections"""
        if not self.test_signaling:
            return
            
        print(f"\n=== Testing signaling server latency with {concurrent_users} concurrent users ===")
        
        # Results container
        latency_results = []
        connection_success = 0
        connection_failures = 0
        
        # Use a thread pool for concurrent connections
        with concurrent.futures.ThreadPoolExecutor(max_workers=concurrent_users) as executor:
            # Function to test a single connection
            def test_connection(index):
                try:
                    # Setup a headless browser
                    driver = self.setup_driver(profile_dir=f"signaling_test_{index}")
                    # Measure connection start time for signaling latency
                    conn_start_time = time.time()
                    driver.get(self.base_url)
                    # Wait for page to load and click create room button
                    create_btn = WebDriverWait(driver, 10).until(
                        EC.element_to_be_clickable((By.ID, "createRoomBtn"))
                    )
                    create_btn_click_time = time.time()
                    create_btn.click()
                    # Wait for room to be created and extract room ID from URL
                    WebDriverWait(driver, 10).until(
                        EC.url_contains("/join-room/")
                    )
                    # Extract room ID from URL
                    room_url = driver.current_url
                    room_id = room_url.split("/")[-1]
                    # Calculate signaling latency
                    room_created_time = time.time()
                    initial_load_time = create_btn_click_time - conn_start_time
                    signaling_latency = room_created_time - create_btn_click_time
                    # Record results
                    latency_results.append({
                        'index': index,
                        'initial_load_time': initial_load_time,
                        'signaling_latency': signaling_latency,
                        'room_id': room_id
                    })
                    connection_success += 1
                except Exception as e:
                    print(f"Error during connection test for user {index}: {e}")
                    connection_failures += 1
                finally:
                    try:
                        driver.quit()
                    except:
                        pass
            # Submit tasks for concurrent execution
            futures = [executor.submit(test_connection, i) for i in range(concurrent_users)]
            # Wait for all tasks to complete
            concurrent.futures.wait(futures)
        # Summarize results
        total_connections = connection_success + connection_failures
        success_rate = (connection_success / total_connections) * 100 if total_connections > 0 else 0
        avg_initial_load_time = statistics.mean([r['initial_load_time'] for r in latency_results]) if latency_results else 0
        avg_signaling_latency = statistics.mean([r['signaling_latency'] for r in latency_results]) if latency_results else 0
        # Add results to signaling metrics
        self.signaling_results.append({
            'operation': 'concurrent_connections',
            'concurrent_users': concurrent_users,
            'success_rate': success_rate,
            'avg_initial_load_time': avg_initial_load_time,
            'avg_signaling_latency': avg_signaling_latency,
            'total_connections': total_connections,
            'connection_success': connection_success,
            'connection_failures': connection_failures
        })
        print(f"""
=== Signaling Latency Test Summary ===
- Concurrent Users: {concurrent_users}
- Success Rate: {success_rate:.2f}%
- Avg Initial Load Time: {avg_initial_load_time:.2f}s
- Avg Signaling Latency: {avg_signaling_latency:.2f}s
- Total Connections: {total_connections}
- Successful Connections: {connection_success}
- Failed Connections: {connection_failures}
""")
    def refresh_peer(self, driver):
        """Attempt to refresh a peer's connection if it's stuck"""
        try:
            print("Refreshing peer connection...")
            driver.refresh()
            # Wait for the page to reload and reconnect
            WebDriverWait(driver, 10).until(
                EC.text_to_be_present_in_element((By.ID, "status"), "Connected")
            )
            print("Peer refreshed successfully")
            return True
        except Exception as e:
            print(f"Error refreshing peer: {e}")
            return False
    def run_benchmark(self):
        """Run the full suite of benchmarks"""
        print("\n=== Starting WebRTC Benchmark Suite ===")
        start_time = time.time()
        # Run signaling latency tests
        if self.test_signaling:
            print("\n=== Running Signaling Latency Tests ===")
            self.test_signaling_latency(concurrent_users=1000)  # Scale up to 1000 users
        # Create rooms and run benchmark iterations
        for iteration in range(self.iterations):
            print(f"\n=== Iteration {iteration+1}/{self.iterations} ===")
            for room_num in range(self.num_rooms):
                print(f"\n=== Testing Room {room_num+1}/{self.num_rooms} ===")
                room_id, creator_driver = self.create_room()
                if not room_id or not creator_driver:
                    print(f"Skipping room {room_num+1} due to creation failure")
                    continue
                # Run benchmark for this room
                room_results = self.run_benchmark_for_room(room_id)
                self.results.extend(room_results)
                # Close the creator driver after the room is done
                try:
                    creator_driver.quit()
                except:
                    pass
        # Summarize results
        end_time = time.time()
        total_time = end_time - start_time
        print(f"\n=== Benchmark Completed in {total_time:.2f}s ===")
        self.summarize_results()
    def summarize_results(self):
        """Summarize and display benchmark results"""
        print("\n=== Benchmark Results Summary ===")
        # Connection Metrics
        if self.connection_results:
            print("\n--- Connection Metrics ---")
            avg_page_load_latency = statistics.mean([r['page_load_latency'] for r in self.connection_results])
            avg_signaling_latency = statistics.mean([r['signaling_latency'] for r in self.connection_results])
            avg_connection_time = statistics.mean([r['connection_time'] for r in self.connection_results])
            print(f"- Avg Page Load Latency: {avg_page_load_latency:.2f}s")
            print(f"- Avg Signaling Latency: {avg_signaling_latency:.2f}s")
            print(f"- Avg Connection Time: {avg_connection_time:.2f}s")
        # File Transfer Metrics
        if self.results:
            print("\n--- File Transfer Metrics ---")
            for size in self.file_sizes:
                size_label = f"{size/1024/1024:.2f} MB" if size >= 1024*1024 else f"{size/1024:.2f} KB"
                size_results = [r for r in self.results if r['file_size'] == size]
                if size_results:
                    avg_transfer_rate = statistics.mean([r['transfer_rate'] for r in size_results])
                    success_count = len(size_results)
                    print(f"- File Size: {size_label}, Avg Transfer Rate: {avg_transfer_rate:.2f} MB/s, Successes: {success_count}")
        # Reconnection Metrics
        if self.reconnection_results:
            print("\n--- Reconnection Metrics ---")
            success_reconnections = [r for r in self.reconnection_results if r['reconnection_success']]
            avg_reconnection_time = statistics.mean([r['reconnection_time_ms'] for r in success_reconnections]) if success_reconnections else 0
            success_rate = (len(success_reconnections) / len(self.reconnection_results)) * 100 if self.reconnection_results else 0
            print(f"- Avg Reconnection Time: {avg_reconnection_time:.2f}ms")
            print(f"- Reconnection Success Rate: {success_rate:.2f}%")
        # Signaling Metrics
        if self.signaling_results:
            print("\n--- Signaling Metrics ---")
            for result in self.signaling_results:
                if result['operation'] == 'create_room':
                    print(f"- Room Creation (Signaling Latency): {result['signaling_latency']:.2f}s")
                elif result['operation'] == 'concurrent_connections':
                    print(f"- Concurrent Users: {result['concurrent_users']}, Success Rate: {result['success_rate']:.2f}%, Avg Latency: {result['avg_signaling_latency']:.2f}s")
if __name__ == "__main__":
    # Parse command-line arguments for configurability
    parser = argparse.ArgumentParser(description="WebRTC Benchmark Suite")
    parser.add_argument("--base-url", type=str, default="http://localhost:5000", help="Base URL of the WebRTC app")
    parser.add_argument("--num-rooms", type=int, default=1, help="Number of rooms to test")
    parser.add_argument("--peers-per-room", type=int, default=2, help="Number of peers per room")
    parser.add_argument("--iterations", type=int, default=1, help="Number of iterations per test")
    parser.add_argument("--headless", action="store_true", help="Run browsers in headless mode")
    parser.add_argument("--test-reconnection", action="store_true", help="Test reconnection logic")
    parser.add_argument("--test-large-files", action="store_true", help="Include large file transfer tests (up to 2GB)")
    parser.add_argument("--test-signaling", action="store_true", help="Test signaling server latency")
    args = parser.parse_args()

    # Initialize the benchmark suite
    benchmark = WebRTCBenchmark(
        base_url=args.base_url,
        num_rooms=args.num_rooms,
        peers_per_room=args.peers_per_room,
        iterations=args.iterations,
        headless=args.headless,
        test_reconnection=args.test_reconnection,
        test_large_files=args.test_large_files,
        test_signaling=args.test_signaling
    )

    # Run the full benchmark suite
    try:
        print("\n=== Starting WebRTC Benchmark Suite ===")
        benchmark.run_benchmark()
    except KeyboardInterrupt:
        print("\nBenchmark interrupted by user.")
    finally:
        # Ensure all resources are cleaned up
        print("\nCleaning up resources...")
        for result in benchmark.results:
            print(f"Result: {result}")
        print("\n=== Benchmark Completed ===")
        with open("benchmark_results.json", "w") as f:
            json.dump(benchmark.results, f, indent=4)
