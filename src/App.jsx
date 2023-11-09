import { useState } from "react";
import "./App.css";
import getPostTitles from "./components/getPostTitles";
import Post from "./components/Post";
let postTitles = await getPostTitles();

function App() {
  // const [postTitles, setPostTitles] = useState([]);

  // console.log(postTitles);
  // setPostTitles(titles);

  return (
    <div className="post-list">
      <h3>List of posts:</h3>
      {postTitles.map((title) => (
        <Post key={title} post={title} />
      ))}
    </div>
  );
}

export default App;
