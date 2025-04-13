# p2p

1. Clone the repository
```bash 
git clone https://github.com/GentleClash/p2p
cd p2p
```
2. Install dependencies
```bash
pip install -r requirements.txt
```
3. Run the server
```bash
python webrtc.py
```
Or use Docker
```bash
docker build -t p2p .
docker run -p 5000:5000 p2p
```



4. Open the browser and navigate to `http://localhost:5000`
5. Click on create room to create a room or enter the room id to join a room.
6. Share the room id with your friend to join the same room.
7. Drag and drop or click on the upload button to upload a file.
8. Click on the download button to download the file.

Note: In case connection is not established, please refresh both ends.