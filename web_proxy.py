import asyncio
import websockets
import json

TCP_HOST = '127.0.0.1'
TCP_PORT = 5555
WS_HOST = '0.0.0.0'
WS_PORT = 8080

async def tcp_to_ws(tcp_reader, ws):
    """Read from TCP server and forward to WebSocket client."""
    try:
        while True:
            # The python server sends newline-delimited JSON
            line = await tcp_reader.readline()
            if not line:
                break
            
            # Send the line (string) back to the WebSocket client
            msg = line.decode('utf-8').strip()
            if msg:
                await ws.send(msg)
                
    except Exception as e:
        print(f"[tcp->ws] Error reading from TCP: {e}")
    finally:
        await ws.close()

async def ws_to_tcp(ws, tcp_writer):
    """Read from WebSocket client and forward to TCP server."""
    try:
        async for message in ws:
            # We must append a newline so the python server knows it's complete
            tcp_writer.write(message.encode('utf-8') + b'\n')
            await tcp_writer.drain()
            
    except Exception as e:
        print(f"[ws->tcp] Error reading from WS: {e}")
    finally:
        tcp_writer.close()

async def handle_client(ws):
    print(f"[*] New WebSocket client connected: {ws.remote_address}")
    try:
        tcp_reader, tcp_writer = await asyncio.open_connection(TCP_HOST, TCP_PORT)
    except Exception as e:
        print(f"[!] Failed to connect to TCP server {TCP_HOST}:{TCP_PORT} -> {e}")
        await ws.close()
        return

    # Run both pipe forwarding loops concurrently
    task1 = asyncio.create_task(tcp_to_ws(tcp_reader, ws))
    task2 = asyncio.create_task(ws_to_tcp(ws, tcp_writer))

    # Wait until one of them finishes/fails
    done, pending = await asyncio.wait(
        [task1, task2],
        return_when=asyncio.FIRST_COMPLETED,
    )

    # Clean up the other task
    for task in pending:
        task.cancel()
    
    tcp_writer.close()
    await tcp_writer.wait_closed()
    print(f"[*] WebSocket connection closed for {ws.remote_address}")

async def main():
    print("======================================================")
    print(f"Starting Proxy bridge:")
    print(f"  WebSockets <- listening on ws://{WS_HOST}:{WS_PORT}")
    print(f"  TCP Server <- connecting to {TCP_HOST}:{TCP_PORT}")
    print("======================================================")
    
    async with websockets.serve(handle_client, WS_HOST, WS_PORT):
        await asyncio.Future()  # Run forever until Ctrl+C

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Shutting down proxy.")
