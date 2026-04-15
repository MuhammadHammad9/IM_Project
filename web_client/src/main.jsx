import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, errorInfo: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, errorInfo) {
    this.setState({ error, errorInfo });
    console.error(error, errorInfo);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{background:'#B91C1C', color:'white', padding:'40px', height: '100vh', width: '100vw', zIndex: 9999, position: 'absolute', top: 0, left: 0}}>
          <h1 style={{fontSize: '32px', marginBottom: '20px'}}>Fatal React Crash</h1>
          <pre style={{whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: '14px', background: 'rgba(0,0,0,0.5)', padding: '20px', borderRadius: '8px'}}>
            {this.state.error.toString()}
            {"\n\n"}
            {this.state.errorInfo?.componentStack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
)
