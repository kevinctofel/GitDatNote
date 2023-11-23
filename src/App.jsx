import { useState, useEffect } from "react";
import "./App.css";
import getPostTitles from "./components/getPostTitles";
import newPost from "./components/newPost"
import Post from "./components/Post";

//:let postTitles = await getPostTitles();
// let titles = [];

// const handleCallback = () => {
//   this.setState({ data: postTitles });
// };

function App() {
  const [postTitles, setPostTitles] = useState([]);

  //useEffect(() => {
  const getPosts = () => {
    getPostTitles().then((response) => setPostTitles(response));
  }
  //}, []);
  const [postText, setPostText] = useState('');
  const [postTitle, setPostTitle] = useState('');
  const handlePublish = () => {
   // console.log(typeof postText, postText);
   newPost(postText);
  };
  const handleTextAreaChange = (event) => {
    setPostText(event.target.value);
  };

  const handleTitleAreaChange = (event) => {
    setPostTitle(event.target.value);
  };

  return (
    <div className="App">
      <button className="NewPost" type="button" value="New" onClick={getPosts}>
        Posts
      </button>
      <h3 className = "one">Posts</h3>
      <ul className="PostTitlesList">
        {postTitles.map((title, index) => (
          <li key={index}>
            <Post {...title} />
          </li>
        ))}
      </ul>
      <form>
      <label>Title:  </label>
        <input type="text" id="postTitle" name="postTitle" onChange={handleTitleAreaChange}/></form>
      <form>
        <label>Post:  </label>
      <textarea type="text" id="postContent" className="two" name="postText" rows="20" cols="50"value={postText} onChange={handleTextAreaChange} default="Markdown here"/>
      <button className="Publish" type="button" value = "Publish" onClick={handlePublish}>Publish</button></form>
    </div>
  );
}

export default App;
