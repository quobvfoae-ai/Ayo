import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getFirestore, collection, query, where, orderBy, limit, getDocs, doc, updateDoc, increment, addDoc, serverTimestamp, getDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut, updatePassword, reauthenticateWithCredential, EmailAuthProvider, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";

let db;
let auth;
let quill;
let lastVisibleLatest = null;
let lastVisiblePolitics = null;
let lastVisibleCategory = null;
const articlesPerPage = 6;
const maxRetries = 3;

// Environment-aware link generators
function getArticleLink(category, slug) {
  const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  return isLocal ? `/articles.html?category=${encodeURIComponent(category)}&slug=${encodeURIComponent(slug)}` : `/${category}/${slug}`;
}

function getCategoryLink(category) {
  const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  return isLocal ? `/category.html?cat=${encodeURIComponent(category)}` : `/category/${category}`;
}

const firebaseConfig = {
  apiKey: window.env?.VITE_FIREBASE_API_KEY || '',
  authDomain: window.env?.VITE_FIREBASE_AUTH_DOMAIN || '',
  projectId: window.env?.VITE_FIREBASE_PROJECT_ID || '',
  storageBucket: window.env?.VITE_FIREBASE_STORAGE_BUCKET || '',
  messagingSenderId: window.env?.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
  appId: window.env?.VITE_FIREBASE_APP_ID || '',
  measurementId: window.env?.VITE_FIREBASE_MEASUREMENT_ID || '',
};

async function initializeFirebase() {
  try {
    if (!window.env?.VITE_FIREBASE_API_KEY) {
      throw new Error("Firebase API key is missing. Ensure environment variables are set in Netlify (VITE_FIREBASE_*) or in your HTML script tag.");
    }
    const app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    auth = getAuth(app);
    console.log('Firebase initialized successfully. Note: Category updates for politics-governance and matoreto-buildline will be handled in article loading functions.');
  } catch (error) {
    console.error('Firebase initialization failed:', error.message);
    displayErrorMessage('body', 'Failed to connect to the database. Check your Firebase environment variables in Netlify or refresh the page.');
  }
}

function displayErrorMessage(selector, message) {
  const elements = document.querySelectorAll(selector);
  if (elements.length === 0) {
    console.warn(`No elements found for selector: ${selector}`);
    return;
  }
  elements.forEach(element => {
    const errorDiv = document.createElement('div');
    errorDiv.classList.add('error-message');
    errorDiv.innerHTML = `
      ${message}
      <button class="dismiss-error" aria-label="Dismiss error">✖</button>
    `;
    element.appendChild(errorDiv);
    errorDiv.querySelector('.dismiss-error').addEventListener('click', () => errorDiv.remove());
  });
}

async function withRetry(fn, retries = maxRetries, delay = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      console.warn(`Retry ${attempt} failed:`, error.message);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

function isValidUrl(string) {
  try {
    new URL(string);
    return true;
  } catch (_) {
    return false;
  }
}

function formatTimestamp(timestamp) {
  try {
    if (!timestamp) {
      console.warn('Timestamp is null or undefined');
      return 'Date Unavailable';
    }
    if (timestamp.toDate && typeof timestamp.toDate === 'function') {
      const date = timestamp.toDate();
      if (isNaN(date.getTime())) {
        console.warn('Invalid Firestore Timestamp:', timestamp);
        return 'Date Unavailable';
      }
      return date.toLocaleDateString();
    }
    console.warn('Timestamp does not have toDate method:', timestamp);
    return 'Date Unavailable';
  } catch (error) {
    console.error('Error formatting timestamp:', error.message, 'Timestamp:', timestamp);
    return 'Date Unavailable';
  }
}

function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

async function getArticleBySlug(slug, category) {
  if (!db) {
    throw new Error('Database not initialized');
  }
  const q = query(
    collection(db, 'articles'),
    where('slug', '==', slug),
    where('category', '==', category)
  );
  const snapshot = await withRetry(() => getDocs(q));
  if (!snapshot.empty) {
    const doc = snapshot.docs[0];
    return { id: doc.id, ...doc.data() };
  }
  return null;
}

document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('article-content-input') && typeof Quill !== 'undefined') {
    quill = new Quill('#article-content-input', {
      theme: 'snow',
      modules: {
        toolbar: [
          [{ 'header': [1, 2, 3, false] }],
          ['bold', 'italic', 'underline', 'strike'],
          [{ 'color': [] }, { 'background': [] }],
          [{ 'list': 'ordered' }, { 'list': 'bullet' }],
          ['link', 'image'],
          ['clean']
        ]
      }
    });
  }

  document.querySelectorAll('.ripple-btn').forEach(element => {
    element.addEventListener('click', function (e) {
      if (element.disabled) return;
      const rect = element.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const ripple = document.createElement('span');
      ripple.classList.add('ripple');
      ripple.style.left = `${x}px`;
      ripple.style.top = `${y}px`;
      const diameter = Math.max(rect.width, rect.height);
      ripple.style.width = ripple.style.height = `${diameter}px`;
      element.appendChild(ripple);
      setTimeout(() => ripple.remove(), 600);
    });
  });

  const changePasswordForms = document.querySelectorAll('#change-password-form');
  changePasswordForms.forEach(form => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!auth.currentUser) {
        displayErrorMessage('#change-password-form', 'You must be logged in to change your password.');
        return;
      }
      const newPassword = form.querySelector('#new-password').value;
      const messageElement = form.querySelector('#password-update-message');

      if (!newPassword || newPassword.length < 6) {
        displayErrorMessage('#change-password-form', 'New password must be at least 6 characters.');
        return;
      }

      try {
        await withRetry(() => updatePassword(auth.currentUser, newPassword));
        messageElement.textContent = 'Password updated successfully!';
        messageElement.style.color = '#28a745';
        form.reset();
        setTimeout(() => {
          messageElement.textContent = '';
        }, 3000);
      } catch (error) {
        console.error('Error updating password:', error.message, error.code);
        let errorMessage = 'Failed to update password: ';
        if (error.code === 'auth/requires-recent-login') {
          errorMessage += 'Recent login required. Please re-enter your current password.';
          const reauthForm = document.createElement('div');
          reauthForm.innerHTML = `
            <label for="current-password">Current Password:</label>
            <input type="password" id="current-password" required aria-label="Current password">
            <button type="button" class="ripple-btn" id="reauth-submit">Re-authenticate</button>
          `;
          form.appendChild(reauthForm);
          const reauthSubmit = reauthForm.querySelector('#reauth-submit');
          reauthSubmit.addEventListener('click', async () => {
            const currentPassword = reauthForm.querySelector('#current-password').value;
            if (!currentPassword) {
              displayErrorMessage('#change-password-form', 'Please enter your current password.');
              return;
            }
            const credential = EmailAuthProvider.credential(auth.currentUser.email, currentPassword);
            try {
              await withRetry(() => reauthenticateWithCredential(auth.currentUser, credential));
              await withRetry(() => updatePassword(auth.currentUser, newPassword));
              messageElement.textContent = 'Password updated successfully!';
              messageElement.style.color = '#28a745';
              form.reset();
              reauthForm.remove();
              setTimeout(() => {
                messageElement.textContent = '';
              }, 3000);
            } catch (reauthError) {
              console.error('Re-authentication error:', reauthError.message);
              displayErrorMessage('#change-password-form', 'Re-authentication failed: Invalid current password.');
            }
          });
        } else if (error.code === 'auth/weak-password') {
          errorMessage += 'Password is too weak. It must be at least 6 characters.';
        } else {
          errorMessage += error.message;
        }
        displayErrorMessage('#change-password-form', errorMessage);
      }
    });
  });

  const forgotPasswordLink = document.getElementById('forgot-password-link');
  const resetPasswordForm = document.getElementById('reset-password-form');
  const loginForm = document.getElementById('admin-login-form');
  const backToLoginLink = document.getElementById('back-to-login-link');
  const resetMessage = document.getElementById('reset-message');

  if (forgotPasswordLink && resetPasswordForm && loginForm && backToLoginLink) {
    forgotPasswordLink.addEventListener('click', (e) => {
      e.preventDefault();
      loginForm.style.display = 'none';
      resetPasswordForm.style.display = 'block';
      changePasswordForms.forEach(form => form.style.display = 'none');
    });

    backToLoginLink.addEventListener('click', (e) => {
      e.preventDefault();
      resetPasswordForm.style.display = 'none';
      loginForm.style.display = 'block';
      resetMessage.textContent = '';
    });

    resetPasswordForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('reset-email').value.trim();
      if (!email || !isValidEmail(email)) {
        resetMessage.textContent = 'Please enter a valid email address.';
        resetMessage.style.color = 'red';
        return;
      }

      resetPasswordForm.querySelector('button[type="submit"]').disabled = true;
      resetMessage.textContent = 'Sending reset email...';
      resetMessage.style.color = 'blue';

      try {
        await withRetry(() => sendPasswordResetEmail(auth, email));
        resetMessage.textContent = 'Password reset email sent successfully! Check your inbox.';
        resetMessage.style.color = '#28a745';
        resetPasswordForm.reset();
        setTimeout(() => {
          resetPasswordForm.style.display = 'none';
          loginForm.style.display = 'block';
          resetMessage.textContent = '';
        }, 3000);
      } catch (error) {
        console.error('Error sending password reset email:', error.message, error.code);
        let errorMessage = 'Failed to send reset email: ';
        if (error.code === 'auth/invalid-email') {
          errorMessage += 'Invalid email address.';
        } else if (error.code === 'auth/user-not-found') {
          errorMessage += 'No user found with this email.';
        } else {
          errorMessage += error.message;
        }
        resetMessage.textContent = errorMessage;
        resetMessage.style.color = 'red';
      } finally {
        resetPasswordForm.querySelector('button[type="submit"]').disabled = false;
      }
    });
  }
});

async function loadArticles() {
  if (!db) {
    displayErrorMessage('.content', 'Unable to load articles: Database not initialized. Check Firebase configuration in Netlify.');
    return;
  }
  const sections = [
    { selector: '.breaking-news-card', collection: 'articles', limit: 1, filter: { breakingNews: true }, orderBy: { field: 'createdAt', direction: 'desc' } },
    { selector: '.fact-check-card', collection: 'articles', limit: 2, filter: { category: 'fact-check', verified: true } }
  ];

  for (const { selector, collection: coll, limit: lim, filter, orderBy: sort } of sections) {
    const elements = document.querySelectorAll(selector);
    let q = query(collection(db, coll));
    if (filter) {
      if (filter.breakingNews) {
        q = query(q, where('breakingNews', '==', true));
      } else {
        q = query(q, where('category', '==', filter.category));
        if (filter.verified) q = query(q, where('verified', '==', true));
      }
    }
    if (sort) q = query(q, orderBy(sort.field, sort.direction));
    q = query(q, limit(lim));
    try {
      console.log(`Executing query for ${selector} with filter:`, filter, 'orderBy:', sort);
      const snapshot = await withRetry(() => getDocs(q));
      console.log(`Loaded ${snapshot.size} articles for ${selector}`, snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
      if (snapshot.empty) {
        console.warn(`No articles found for ${selector} with filter:`, filter);
        if (selector === '.breaking-news-card') {
          console.log('No breaking news articles found, attempting fallback to latest article');
          let fallbackQuery = query(collection(db, 'articles'), orderBy('createdAt', 'desc'), limit(1));
          const fallbackSnapshot = await withRetry(() => getDocs(fallbackQuery));
          console.log(`Fallback query loaded ${fallbackSnapshot.size} articles`, fallbackSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
          if (!fallbackSnapshot.empty) {
            const article = fallbackSnapshot.docs[0].data();
            const docId = fallbackSnapshot.docs[0].id;
            const element = elements[0];
            if (element && element.dataset.placeholder === 'true') {
              element.dataset.id = docId;
              const link = element.querySelector('.article-link');
              const imageUrl = article.image && isValidUrl(article.image) ? article.image : 'https://via.placeholder.com/400x200';
              console.log(`Rendering fallback breaking news article ID: ${docId}, Image URL: ${imageUrl}, CreatedAt:`, article.createdAt);
              const img = link.querySelector('img');
              img.src = '';
              img.src = imageUrl;
              img.alt = article.title || 'Article Image';
              img.srcset = `${imageUrl} 400w, ${imageUrl} 200w, ${imageUrl} 800w`;
              img.sizes = '(max-width: 480px) 100vw, (max-width: 767px) 80vw, 400px';
              img.loading = 'lazy';
              img.onerror = () => {
                console.warn(`Fallback image failed to load for article ID: ${docId}, URL: ${imageUrl}`);
                img.src = 'https://via.placeholder.com/400x200';
                img.srcset = 'https://via.placeholder.com/400x200 400w, https://via.placeholder.com/200x100 200w';
                img.sizes = '(max-width: 480px) 100vw, (max-width: 767px) 80vw, 400px';
              };
              img.onload = () => {
                console.log(`Fallback image loaded successfully for article ID: ${docId}, URL: ${img.src}`);
                img.style.display = 'block';
              };
              link.setAttribute('href', getArticleLink(article.category, article.slug));
              link.querySelector('h2, h3').textContent = article.title || 'Untitled Article';
              link.querySelector('p').textContent = article.summary || (article.content ? article.content.substring(0, 100) + '...' : 'No summary available');
              const timeElement = link.querySelector('.article-time') || document.createElement('p');
              timeElement.classList.add('article-time');
              timeElement.textContent = `Posted: ${formatTimestamp(article.createdAt)}`;
              if (!link.querySelector('.article-time')) {
                link.appendChild(timeElement);
              }
              const writerElement = link.querySelector('.article-writer') || document.createElement('p');
              writerElement.classList.add('article-writer', 'premium-writer');
              writerElement.textContent = `By ${article.writer || 'Anonymous'}`;
              if (!link.querySelector('.article-writer')) {
                link.insertBefore(writerElement, timeElement);
              }
              const badge = element.querySelector('.breaking-news-badge');
              if (badge) badge.style.display = 'none';
              element.dataset.placeholder = 'false';
            }
          } else {
            console.warn('No fallback articles available for breaking news');
            elements.forEach(element => {
              element.innerHTML = '<p>No breaking news available at this time.</p>';
              element.dataset.placeholder = 'false';
            });
          }
        } else {
          elements.forEach(element => {
            element.innerHTML = '<p>No articles available.</p>';
            element.dataset.placeholder = 'false';
          });
        }
        continue;
      }
      let index = 0;
      snapshot.forEach(doc => {
        const article = doc.data();
        const element = elements[index];
        if (element && element.dataset.placeholder === 'true') {
          element.dataset.id = doc.id;
          const link = element.querySelector('.article-link');
          const imageUrl = article.image && isValidUrl(article.image) ? article.image : 'https://via.placeholder.com/400x200';
          console.log(`Rendering ${selector} article ID: ${doc.id}, Image URL: ${imageUrl}, CreatedAt:`, article.createdAt);
          const img = link.querySelector('img');
          img.src = '';
          img.src = imageUrl;
          img.alt = article.title || 'Article Image';
          img.srcset = `${imageUrl} 400w, ${imageUrl} 200w, ${imageUrl} 800w`;
          img.sizes = '(max-width: 480px) 100vw, (max-width: 767px) 80vw, 400px';
          img.loading = 'lazy';
          img.onerror = () => {
            console.warn(`Image failed to load for article ID: ${doc.id}, URL: ${imageUrl}`);
            img.src = 'https://via.placeholder.com/400x200';
            img.srcset = 'https://via.placeholder.com/400x200 400w, https://via.placeholder.com/200x100 200w';
            img.sizes = '(max-width: 480px) 100vw, (max-width: 767px) 80vw, 400px';
          };
          img.onload = () => {
            console.log(`Image loaded successfully for article ID: ${doc.id}, URL: ${img.src}`);
            img.style.display = 'block';
          };
          link.setAttribute('href', getArticleLink(article.category, article.slug));
          link.querySelector('h2, h3').textContent = article.title || 'Untitled Article';
          link.querySelector('p').textContent = article.summary || (article.content ? article.content.substring(0, 100) + '...' : 'No summary available');
          const timeElement = link.querySelector('.article-time') || document.createElement('p');
          timeElement.classList.add('article-time');
          timeElement.textContent = `Posted: ${formatTimestamp(article.createdAt)}`;
          if (!link.querySelector('.article-time')) {
            link.appendChild(timeElement);
          }
          const writerElement = link.querySelector('.article-writer') || document.createElement('p');
          writerElement.classList.add('article-writer', 'premium-writer');
          writerElement.textContent = `By ${article.writer || 'Anonymous'}`;
          if (!link.querySelector('.article-writer')) {
            link.insertBefore(writerElement, timeElement);
          }
          if (article.breakingNews && element.classList.contains('breaking-news-card')) {
            let badge = element.querySelector('.breaking-news-badge');
            if (!badge) {
              badge = document.createElement('span');
              badge.classList.add('breaking-news-badge');
              badge.textContent = 'Breaking News';
              link.appendChild(badge);
            }
            badge.style.display = 'block';
          } else {
            const badge = element.querySelector('.breaking-news-badge');
            if (badge) badge.style.display = 'none';
          }
          if (article.verified && element.classList.contains('fact-check-card')) {
            let badge = element.querySelector('.verified-badge');
            if (!badge) {
              badge = document.createElement('span');
              badge.classList.add('verified-badge');
              badge.textContent = 'Verified';
              link.appendChild(badge);
            }
            badge.style.display = 'block';
          } else {
            const badge = element.querySelector('.verified-badge');
            if (badge) badge.style.display = 'none';
          }
          element.dataset.placeholder = 'false';
          index++;
        }
      });
      while (index < elements.length) {
        elements[index].innerHTML = '<p>No articles available.</p>';
        elements[index].dataset.placeholder = 'false';
        index++;
      }
    } catch (error) {
      console.error(`Error loading ${selector}:`, error.message, error.code);
      let errorMessage = `Failed to load articles for ${selector}: ${error.message}. `;
      if (error.code === 'permission-denied') {
        errorMessage += 'Check Firestore security rules to ensure public read access to the "articles" collection.';
      } else if (error.code === 'unavailable' || error.code === 'deadline-exceeded') {
        errorMessage += 'Network issue detected. Check your internet connection or Netlify configuration.';
      } else {
        errorMessage += 'Verify the Firestore "articles" collection or try refreshing the page.';
      }
      displayErrorMessage(selector, errorMessage);
    }
  }

  const breakingNewsQuery = query(collection(db, 'articles'), where('breakingNews', '==', true), orderBy('createdAt', 'desc'), limit(1));
  try {
    const snapshot = await withRetry(() => getDocs(breakingNewsQuery));
    if (!snapshot.empty) {
      const article = snapshot.docs[0].data();
      const imageUrl = article.image && isValidUrl(article.image) ? article.image : 'https://via.placeholder.com/1200x630';
      console.log('Breaking news meta image:', imageUrl);
      document.querySelector('meta[property="og:title"]').setAttribute('content', `Naija Truths - ${article.title || 'Breaking News'}`);
      document.querySelector('meta[name="description"]').setAttribute('content', article.summary || (article.content ? article.content.substring(0, 160) : 'Breaking news from Naija Truths'));
      document.querySelector('meta[property="og:description"]').setAttribute('content', article.summary || (article.content ? article.content.substring(0, 160) : 'Breaking news from Naija Truths'));
      document.querySelector('meta[property="og:image"]').setAttribute('content', imageUrl);
      document.title = `Naija Truths - ${article.title || 'Breaking News'}`;
    }
  } catch (error) {
    console.error('Error updating meta tags:', error.message);
  }
}

async function loadArticle() {
  const urlParams = new URLSearchParams(window.location.search);
  const id = urlParams.get('id');
  const categoryFromQuery = urlParams.get('category');
  const slugFromQuery = urlParams.get('slug');
  const path = window.location.pathname;
  const pathParts = path.split('/').filter(part => part);
  const categoryFromPath = pathParts[0];
  const slugFromPath = pathParts[1];
  const category = categoryFromQuery || categoryFromPath;
  const slug = slugFromQuery || slugFromPath;
  console.log('Attempting to load article with Category:', category, 'Slug:', slug, 'ID:', id);

  if (!db) {
    console.error('Database not initialized');
    displayErrorMessage('#article-content', 'Unable to load article: Database not initialized. Please check your Firebase configuration or internet connection.');
    return;
  }

  let article;
  let isPreview = false;
  if (id) {
    try {
      const docRef = doc(db, 'articles', id);
      const docSnap = await withRetry(() => getDoc(docRef));
      if (docSnap.exists()) {
        article = { id: docSnap.id, ...docSnap.data() };
        if (article.category && article.slug) {
          const cleanUrl = getArticleLink(article.category, article.slug);
          console.log('Redirecting to clean URL:', cleanUrl);
          window.location.replace(cleanUrl);
          return;
        }
      } else {
        console.error('Article not found for ID:', id);
        displayErrorMessage('#article-content', 'Article not found. It may have been deleted or the ID is incorrect.');
        return;
      }
    } catch (error) {
      console.error('Error loading article by ID:', id, error.message, error.code);
      displayErrorMessage('#article-content', `Failed to load article: ${error.message}. Check Firestore or try refreshing.`);
      return;
    }
  } else if (category && slug) {
    const previewArticle = JSON.parse(localStorage.getItem('previewArticle') || '{}');
    if (previewArticle.category === category && previewArticle.slug === slug) {
      article = previewArticle;
      isPreview = true;
      console.log('Using preview article from localStorage:', article.title);
    } else {
      try {
        article = await getArticleBySlug(slug, category);
        if (!article) {
          console.error('Article not found in Firestore for Category:', category, 'Slug:', slug);
          displayErrorMessage('#article-content', `Article not found. It may have been deleted or the URL is incorrect.`);
          return;
        }
      } catch (error) {
        console.error('Error loading article (Category:', category, 'Slug:', slug, '):', error.message, error.code);
        let errorMessage = `Failed to load article: ${error.message}. `;
        if (error.code === 'permission-denied') {
          errorMessage += 'Check Firestore security rules to ensure public read access to the "articles" collection.';
        } else if (error.code === 'unavailable' || error.code === 'deadline-exceeded') {
          errorMessage += 'Network issue detected. Check your internet connection and try again.';
        } else {
          errorMessage += 'Check Firestore for the article or try refreshing the page.';
        }
        displayErrorMessage('#article-content', errorMessage);
        return;
      }
    }
  } else {
    console.error('No category, slug, or ID provided in URL');
    displayErrorMessage('#article-content', 'No article specified in the URL. Please select an article from the homepage or check the link.');
    return;
  }

  console.log('Article loaded successfully:', article.title, 'Verified:', article.verified, 'Breaking News:', article.breakingNews, 'Image:', article.image, 'Is Preview:', isPreview);

  const articleTitle = document.getElementById('article-title');
  const articleMeta = document.getElementById('article-meta');
  const articleImage = document.getElementById('article-image');
  const articleVideo = document.getElementById('article-video');
  const articleBreakingNews = document.getElementById('article-breaking-news');
  const articleVerified = document.getElementById('article-verified');
  const articleContent = document.getElementById('article-content');
  const articleCard = document.querySelector('.article-card');
  const likeCount = document.getElementById('like-count');

  if (!articleTitle || !articleMeta || !articleContent || !articleCard || !likeCount) {
    console.error('One or more required DOM elements are missing:', {
      articleTitle: !!articleTitle,
      articleMeta: !!articleMeta,
      articleContent: !!articleContent,
      articleCard: !!articleCard,
      likeCount: !!likeCount
    });
    displayErrorMessage('#article-content', 'Failed to load article: Page elements are missing. Please check the HTML structure of articles.html.');
    return;
  }

  articleCard.dataset.preview = isPreview.toString();
  articleTitle.textContent = article.title || 'Untitled Article';
  document.querySelector('meta[property="og:title"]').setAttribute('content', article.title || 'Naija Truths Article');
  document.querySelector('meta[name="description"]').setAttribute('content', article.summary || (article.content ? article.content.substring(0, 160) : 'Article from Naija Truths'));
  document.querySelector('meta[property="og:description"]').setAttribute('content', article.summary || (article.content ? article.content.substring(0, 160) : 'Article from Naija Truths'));
  const imageUrl = article.image && isValidUrl(article.image) ? article.image : 'https://via.placeholder.com/1200x630';
  document.querySelector('meta[property="og:image"]').setAttribute('content', imageUrl);
  document.querySelector('meta[property="og:url"]').setAttribute('content', `https://naija-truths.netlify.app${getArticleLink(article.category, article.slug)}`);
  document.querySelector('link[rel="canonical"]').setAttribute('href', `https://naija-truths.netlify.app${getArticleLink(article.category, article.slug)}`);
  document.title = `Naija Truths - ${article.title || 'Article'}`;

  if (articleImage) {
    if (article.image && isValidUrl(article.image)) {
      articleImage.src = article.image;
      articleImage.srcset = `${article.image} 1200w, ${article.image} 768w, ${article.image} 480w`;
      articleImage.sizes = '(max-width: 480px) 100vw, (max-width: 768px) 80vw, 800px';
      articleImage.alt = article.title || 'Article Image';
      articleImage.loading = 'lazy';
      articleImage.style.display = 'block';
      articleImage.onerror = () => {
        console.warn(`Article image failed to load for ID: ${article.id}, URL: ${article.image}`);
        articleImage.src = 'https://via.placeholder.com/800x400';
        articleImage.srcset = 'https://via.placeholder.com/400x200 480w, https://via.placeholder.com/800x400 768w, https://via.placeholder.com/1200x600 1200w';
        articleImage.sizes = '(max-width: 480px) 100vw, (max-width: 768px) 80vw, 800px';
        articleImage.style.display = 'block';
      };
    } else {
      articleImage.src = 'https://via.placeholder.com/800x400';
      articleImage.srcset = 'https://via.placeholder.com/400x200 480w, https://via.placeholder.com/800x400 768w, https://via.placeholder.com/1200x600 1200w';
      articleImage.sizes = '(max-width: 480px) 100vw, (max-width: 768px) 80vw, 800px';
      articleImage.alt = 'Article Image';
      articleImage.loading = 'lazy';
      articleImage.style.display = 'block';
    }
  } else {
    console.warn('Article image element not found');
  }

  articleMeta.textContent = `By ${article.writer || 'Anonymous'} on ${formatTimestamp(article.createdAt)}`;
  articleMeta.classList.add('premium-writer');

  if (articleContent) {
    articleContent.innerHTML = article.content || 'No content available';
  }

  if (articleVideo) {
    if (article.video && isValidUrl(article.video)) {
      articleVideo.src = article.video;
      articleVideo.style.display = 'block';
    } else {
      articleVideo.style.display = 'none';
    }
  } else {
    console.warn('Article video element not found');
  }

  if (articleBreakingNews) {
    articleBreakingNews.style.display = article.breakingNews ? 'block' : 'none';
  } else {
    console.warn('Breaking news badge element not found');
  }

  if (articleVerified) {
    articleVerified.style.display = article.verified ? 'block' : 'none';
  } else {
    console.warn('Verified badge element not found');
  }

  articleCard.dataset.id = article.id || 'preview';
  likeCount.textContent = article.likes || 0;

  const saveButton = document.querySelector('.article-card .save-button');
  if (saveButton) {
    const savedArticles = JSON.parse(localStorage.getItem('savedArticles') || '[]');
    if (savedArticles.includes(article.id)) {
      saveButton.classList.add('saved');
      saveButton.querySelector('.action-text').textContent = 'Saved';
      saveButton.disabled = true;
    }
  }

  const likeButton = document.querySelector('.article-card .like-button');
  if (likeButton) {
    const likedArticles = JSON.parse(localStorage.getItem('likedArticles') || '[]');
    if (likedArticles.includes(article.id)) {
      likeButton.classList.add('liked');
      likeButton.disabled = true;
    }
  }

  if (!isPreview) {
    await withRetry(() => updateDoc(doc(db, 'articles', article.id), { views: increment(1) }));
    loadComments(article.id);
  } else {
    const commentList = document.getElementById('comment-list');
    if (commentList) {
      commentList.innerHTML = '<p>Comments are disabled in preview mode.</p>';
    }
  }
}

async function loadCategoryArticles() {
  const urlParams = new URLSearchParams(window.location.search);
  let category = urlParams.get('cat');
  
  // Handle clean URLs like /category/politics-governance
  const pathSegments = window.location.pathname.split('/').filter(segment => segment);
  if (pathSegments[0] === 'category' && pathSegments[1]) {
    category = pathSegments[1];
  }

  if (!db) {
    console.error('Database not initialized');
    displayErrorMessage('#category-articles', 'Unable to load articles: Database not initialized. Check Firebase configuration in Netlify.');
    return;
  }

  if (!category) {
    console.error('No category provided in URL');
    displayErrorMessage('#category-articles', 'No category specified in the URL. Please select a category from the navigation.');
    return;
  }

  const categoryTitle = document.getElementById('category-title');
  const categoryArticles = document.getElementById('category-articles');
  if (!categoryTitle || !categoryArticles) {
    console.error('Category title or articles container not found');
    displayErrorMessage('.category-section', 'Page elements missing. Check the HTML structure of category.html.');
    return;
  }

  const formattedCategory = category
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' & ');
  categoryTitle.textContent = formattedCategory;
  document.title = `Naija Truths - ${formattedCategory}`;
  document.querySelector('meta[name="description"]').setAttribute('content', `Explore ${formattedCategory} news on Naija Truths.`);
  document.querySelector('meta[property="og:title"]').setAttribute('content', `Naija Truths - ${formattedCategory}`);
  document.querySelector('meta[property="og:description"]').setAttribute('content', `Explore ${formattedCategory} news on Naija Truths.`);
  document.querySelector('meta[property="og:image"]').setAttribute('content', 'https://via.placeholder.com/1200x630');
  document.querySelector('meta[property="og:url"]').setAttribute('content', `https://naija-truths.netlify.app${getCategoryLink(category)}`);
  document.querySelector('link[rel="canonical"]').setAttribute('href', `https://naija-truths.netlify.app${getCategoryLink(category)}`);

  // TODO: Populate #subcategory-list if subcategory navigation is implemented in the future
  // Currently, subcategory-nav is hidden via CSS (.subcategory-nav:empty { display: none; })

  lastVisibleCategory = null;
  categoryArticles.innerHTML = '<p>Loading articles...</p>';
  await fetchCategoryArticles(category, true);
}

async function fetchCategoryArticles(category, reset = false) {
  const categoryArticles = document.getElementById('category-articles');
  const loadMoreButton = document.querySelector('.category-section .load-more-button');
  if (!db || !categoryArticles) {
    console.error('Database or category articles container not initialized');
    displayErrorMessage('#category-articles', 'Unable to load articles: Database or page elements not initialized.');
    if (loadMoreButton) {
      loadMoreButton.style.display = 'none';
      loadMoreButton.textContent = 'Load More';
      loadMoreButton.disabled = false;
      loadMoreButton.setAttribute('aria-busy', 'false');
    }
    return;
  }

  const validCategories = [
    'politics-governance',
    'fact-check',
    'sports',
    'entertainment',
    'matoreto-buildline',
    'economy-business',
    'security-justice',
    'society-culture',
    'health-education',
    'techlens',
    'investigations',
    'opinion-editorials',
    'columns',
    'infographics',
    'videos-documentaries'
  ];

  if (!validCategories.includes(category)) {
    console.warn(`Invalid category provided: ${category}`);
    displayErrorMessage('#category-articles', `Invalid category "${category}". Please select a valid category from the navigation.`);
    if (loadMoreButton) {
      loadMoreButton.style.display = 'none';
      loadMoreButton.textContent = 'Load More';
      loadMoreButton.disabled = false;
      loadMoreButton.setAttribute('aria-busy', 'false');
    }
    return;
  }

  if (reset) {
    lastVisibleCategory = null;
    categoryArticles.innerHTML = '';
  }

  let q = query(
    collection(db, 'articles'),
    where('category', '==', category),
    orderBy('createdAt', 'desc'),
    limit(articlesPerPage)
  );
  if (lastVisibleCategory && !reset) q = query(q, startAfter(lastVisibleCategory));

  try {
    console.log(`Fetching articles for category: ${category}, reset: ${reset}, lastVisible: ${lastVisibleCategory ? lastVisibleCategory.id : 'none'}`);
    const snapshot = await withRetry(() => getDocs(q));
    console.log(`Found ${snapshot.size} articles for category: ${category}`);

    const formattedCategory = category
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' & ');

    let totalArticles = snapshot.size;
    if (reset) {
      const totalQuery = query(collection(db, 'articles'), where('category', '==', category));
      const totalSnapshot = await withRetry(() => getDocs(totalQuery));
      totalArticles = totalSnapshot.size;
      console.log(`Total articles in category ${category}: ${totalArticles}`);
    }

    if (snapshot.empty && categoryArticles.innerHTML === '') {
      console.warn(`No articles found for category: ${category}`);
      categoryArticles.innerHTML = `<p>No ${formattedCategory} articles found.</p>`;
      if (loadMoreButton) {
        loadMoreButton.style.display = 'none';
        loadMoreButton.textContent = 'Load More';
        loadMoreButton.disabled = false;
        loadMoreButton.setAttribute('aria-busy', 'false');
      }
      return;
    }

    if (totalArticles === 1 && reset) {
      console.log(`Only one article found for category: ${category}`);
      categoryArticles.innerHTML = `<p>Only one ${formattedCategory} article available.</p>`;
    }

    snapshot.forEach(doc => {
      const article = doc.data();
      const articleElement = document.createElement('article');
      articleElement.classList.add('news-card');
      articleElement.dataset.id = doc.id;
      const imageUrl = article.image && isValidUrl(article.image) ? article.image : 'https://via.placeholder.com/400x200';
      console.log(`Rendering article ID: ${doc.id}, Title: ${article.title}, Image URL: ${imageUrl}`);
      articleElement.innerHTML = `
        <a href="${getArticleLink(article.category, article.slug)}" class="article-link">
          <img src="${imageUrl}" 
               srcset="${imageUrl} 400w, ${imageUrl} 200w, ${imageUrl} 800w" 
               sizes="(max-width: 480px) 100vw, (max-width: 767px) 80vw, 400px" 
               alt="${article.title || 'Article Image'}" 
               loading="lazy"
               onerror="this.src='https://via.placeholder.com/400x200'; this.srcset='https://via.placeholder.com/400x200 400w, https://via.placeholder.com/200x100 200w'; this.sizes='(max-width: 480px) 100vw, (max-width: 767px) 80vw, 400px';">
          <h3>${article.title || 'Untitled Article'}</h3>
          <p class="article-writer premium-writer">By ${article.writer || 'Anonymous'}</p>
          <p>${article.summary || (article.content ? article.content.substring(0, 100) + '...' : 'No summary available')}</p>
          <p class="article-time">Posted: ${formatTimestamp(article.createdAt)}</p>
          ${article.breakingNews ? '<span class="breaking-news-badge">Breaking News</span>' : ''}
          ${article.verified ? '<span class="verified-badge">Verified</span>' : ''}
        </a>
        <div class="article-actions">
          <button class="like-button ripple-btn" aria-label="Like this article">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#000000" stroke-width="2">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
            </svg>
            <span id="like-count">${article.likes || 0}</span>
          </button>
          <button class="save-button ripple-btn" aria-label="Save this article">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#000000" stroke-width="2">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
            </svg>
            <span class="action-text">Save</span>
          </button>
        </div>
      `;
      if (totalArticles > 1 || !reset) {
        categoryArticles.appendChild(articleElement);
      } else if (totalArticles === 1) {
        categoryArticles.insertBefore(articleElement, categoryArticles.firstChild);
      }
    });

    // Update meta image if articles are loaded
    if (snapshot.docs.length > 0) {
      const firstArticle = snapshot.docs[0].data();
      if (firstArticle.image && isValidUrl(firstArticle.image)) {
        document.querySelector('meta[property="og:image"]').setAttribute('content', firstArticle.image);
      }
    }

    document.querySelectorAll('#category-articles .news-card .save-button').forEach(button => {
      const articleId = button.closest('.news-card')?.dataset.id;
      if (articleId) {
        const savedArticles = JSON.parse(localStorage.getItem('savedArticles') || '[]');
        if (savedArticles.includes(articleId)) {
          button.classList.add('saved');
          button.querySelector('.action-text').textContent = 'Saved';
          button.disabled = true;
        }
      }
    });

    document.querySelectorAll('#category-articles .news-card .like-button').forEach(button => {
      const articleId = button.closest('.news-card')?.dataset.id;
      if (articleId) {
        const likedArticles = JSON.parse(localStorage.getItem('likedArticles') || '[]');
        if (likedArticles.includes(articleId)) {
          button.classList.add('liked');
          button.disabled = true;
        }
      }
    });

    lastVisibleCategory = snapshot.docs[snapshot.docs.length - 1];
    if (loadMoreButton) {
      if (totalArticles <= articlesPerPage) {
        loadMoreButton.style.display = 'none';
        loadMoreButton.textContent = 'Load More';
        loadMoreButton.disabled = false;
        loadMoreButton.setAttribute('aria-busy', 'false');
        if (totalArticles === 1 && reset) {
          console.log(`Hiding load more button for category ${category} as only one article exists`);
        } else if (snapshot.size < articlesPerPage) {
          console.log(`Hiding load more button for category ${category} as no more articles are available`);
        }
      } else {
        loadMoreButton.style.display = 'block';
        loadMoreButton.textContent = 'Load More';
        loadMoreButton.disabled = false;
        loadMoreButton.setAttribute('aria-busy', 'false');
      }
    }
  } catch (error) {
    console.error(`Error loading category articles for "${category}":`, error.message, error.code);
    let errorMessage = `Failed to load articles for "${category.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' & ')}": ${error.message}. `;
    if (error.code === 'permission-denied') {
      errorMessage += 'Check Firestore security rules to ensure public read access to the "articles" collection.';
    } else if (error.code === 'unavailable' || error.code === 'deadline-exceeded') {
      errorMessage += 'Network issue detected. Check your internet connection and try again.';
    } else {
      errorMessage += `Verify that articles exist in Firestore with category "${category}" or try refreshing the page.`;
    }
    displayErrorMessage('#category-articles', errorMessage);
    if (loadMoreButton) {
      loadMoreButton.style.display = 'none';
      loadMoreButton.textContent = 'Load More';
      loadMoreButton.disabled = false;
      loadMoreButton.setAttribute('aria-busy', 'false');
    }
  }
}
async function loadPoliticsArticles() {
  const politicsArticles = document.getElementById('politics-articles');
  if (!db || !politicsArticles) return;

  lastVisiblePolitics = null;
  politicsArticles.innerHTML = '';
  await fetchPoliticsArticles(true);
}

async function fetchPoliticsArticles(reset = false) {
  const politicsArticles = document.getElementById('politics-articles');
  const loadMoreButton = document.querySelector('.latest-news .load-more-button');
  if (!db || !politicsArticles) return;

  if (reset) {
    lastVisiblePolitics = null;
    politicsArticles.innerHTML = '';
  }

  let q = query(
    collection(db, 'articles'),
    where('category', '==', 'politics-governance'),
    orderBy('createdAt', 'desc'),
    limit(articlesPerPage)
  );
  if (lastVisiblePolitics && !reset) q = query(q, startAfter(lastVisiblePolitics));

  try {
    console.log('Fetching politics articles for category: politics-governance');
    const snapshot = await withRetry(() => getDocs(q));
    if (snapshot.empty && politicsArticles.innerHTML === '') {
      politicsArticles.innerHTML = '<p>No Politics & Governance articles found.</p>';
      if (loadMoreButton) loadMoreButton.style.display = 'none';
      return;
    }

    snapshot.forEach(doc => {
      const article = doc.data();
      const articleElement = document.createElement('article');
      articleElement.classList.add('news-card');
      articleElement.dataset.id = doc.id;
      const imageUrl = article.image && isValidUrl(article.image) ? article.image : 'https://via.placeholder.com/400x200';
      console.log(`Politics article ID: ${doc.id}, Image URL: ${imageUrl}`);
      articleElement.innerHTML = `
        <a href="${getArticleLink(article.category, article.slug)}" class="article-link">
          <img src="${imageUrl}" 
               srcset="${imageUrl} 400w, ${imageUrl} 200w, ${imageUrl} 800w" 
               sizes="(max-width: 480px) 100vw, (max-width: 767px) 80vw, 400px" 
               alt="${article.title || 'Article Image'}" 
               loading="lazy"
               onerror="this.src='https://via.placeholder.com/400x200'; this.srcset='https://via.placeholder.com/400x200 400w, https://via.placeholder.com/200x100 200w'; this.sizes='(max-width: 480px) 100vw, (max-width: 767px) 80vw, 400px';">
          <h3>${article.title || 'Untitled Article'}</h3>
          <p class="article-writer premium-writer">By ${article.writer || 'Anonymous'}</p>
          <p>${article.summary || (article.content ? article.content.substring(0, 100) + '...' : 'No summary available')}</p>
          <p class="article-time">Posted: ${formatTimestamp(article.createdAt)}</p>
          ${article.breakingNews ? '<span class="breaking-news-badge">Breaking News</span>' : ''}
          ${article.verified ? '<span class="verified-badge">Verified</span>' : ''}
        </a>
      `;
      politicsArticles.appendChild(articleElement);
    });

    lastVisiblePolitics = snapshot.docs[snapshot.docs.length - 1];
    if (loadMoreButton) loadMoreButton.style.display = snapshot.size < articlesPerPage ? 'none' : 'block';
  } catch (error) {
    console.error('Error loading politics articles:', error.message);
    displayErrorMessage('#politics-articles', 'Failed to load Politics & Governance articles. Please try again.');
  }
}

async function loadLatestNewsArticles(category = '') {
  const latestNewsArticles = document.getElementById('latest-news-articles');
  const loadMoreButton = document.querySelector('.latest-news .load-more-button');
  if (!db || !latestNewsArticles) {
    console.error('Database or latest news articles container not initialized');
    displayErrorMessage('#latest-news-articles', 'Unable to load articles: Database or page elements not initialized.');
    return;
  }

  lastVisibleLatest = null;
  latestNewsArticles.innerHTML = '';
  await fetchLatestNewsArticles(true, loadMoreButton, category);
}

async function fetchLatestNewsArticles(reset = false, loadMoreButton, category = '') {
  const latestNewsArticles = document.getElementById('latest-news-articles');
  if (!db || !latestNewsArticles) {
    console.error('Database or latest news articles container not initialized');
    displayErrorMessage('#latest-news-articles', 'Unable to load articles: Database or page elements not initialized.');
    return;
  }

  if (reset) {
    lastVisibleLatest = null;
    latestNewsArticles.innerHTML = '';
  }

  const validCategories = [
    'politics-governance',
    'fact-check',
    'sports',
    'entertainment',
    'matoreto-buildline',
    'economy-business',
    'security-justice',
    'society-culture',
    'health-education',
    'techlens',
    'investigations',
    'opinion-editorials',
    'columns',
    'infographics',
    'videos-documentaries'
  ];

  if (category && !validCategories.includes(category)) {
    console.warn(`Invalid category provided: ${category}. Falling back to all categories.`);
    displayErrorMessage('#latest-news-articles', `Invalid category "${category}". Showing all articles instead.`);
    category = '';
  }

  let q;
  if (category) {
    q = query(
      collection(db, 'articles'),
      where('category', '==', category),
      orderBy('createdAt', 'desc'),
      limit(articlesPerPage)
    );
  } else {
    q = query(
      collection(db, 'articles'),
      orderBy('createdAt', 'desc'),
      limit(articlesPerPage)
    );
  }
  if (lastVisibleLatest && !reset) {
    q = query(q, startAfter(lastVisibleLatest));
  }

  try {
    console.log(`Fetching latest news articles${category ? ` for category: ${category}` : ''}, reset: ${reset}, lastVisible: ${lastVisibleLatest ? lastVisibleLatest.id : 'none'}`);
    const snapshot = await withRetry(() => getDocs(q));
    console.log(`Found ${snapshot.size} articles${category ? ` for category: ${category}` : ''}`);

    if (snapshot.empty && latestNewsArticles.innerHTML === '') {
      console.warn(`No articles found${category ? ` for category: ${category}` : ''}`);
      latestNewsArticles.innerHTML = `<p>No ${category ? category.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' & ') : 'articles'} found.</p>`;
      if (loadMoreButton) loadMoreButton.style.display = 'none';
      return;
    }

    snapshot.forEach(doc => {
      const article = doc.data();
      const articleElement = document.createElement('article');
      articleElement.classList.add('news-card');
      articleElement.dataset.id = doc.id;
      const imageUrl = article.image && isValidUrl(article.image) ? article.image : 'https://via.placeholder.com/400x200';
      console.log(`Rendering latest news article ID: ${doc.id}, Title: ${article.title}, Image URL: ${imageUrl}`);
      articleElement.innerHTML = `
        <a href="${getArticleLink(article.category, article.slug)}" class="article-link">
          <img src="${imageUrl}" 
               srcset="${imageUrl} 400w, ${imageUrl} 200w, ${imageUrl} 800w" 
               sizes="(max-width: 480px) 100vw, (max-width: 767px) 80vw, 400px" 
               alt="${article.title || 'Article Image'}" 
               loading="lazy"
               onerror="this.src='https://via.placeholder.com/400x200'; this.srcset='https://via.placeholder.com/400x200 400w, https://via.placeholder.com/200x100 200w'; this.sizes='(max-width: 480px) 100vw, (max-width: 767px) 80vw, 400px';">
          <h3>${article.title || 'Untitled Article'}</h3>
          <p class="article-writer premium-writer">By ${article.writer || 'Anonymous'}</p>
          <p>${article.summary || (article.content ? article.content.substring(0, 100) + '...' : 'No summary available')}</p>
          <p class="article-time">Posted: ${formatTimestamp(article.createdAt)}</p>
          ${article.breakingNews ? '<span class="breaking-news-badge">Breaking News</span>' : ''}
          ${article.verified ? '<span class="verified-badge">Verified</span>' : ''}
        </a>
      `;
      latestNewsArticles.appendChild(articleElement);
    });

    lastVisibleLatest = snapshot.docs[snapshot.docs.length - 1];
    if (loadMoreButton) {
      loadMoreButton.style.display = snapshot.size < articlesPerPage ? 'none' : 'block';
      loadMoreButton.textContent = 'Load More';
      loadMoreButton.disabled = false;
      loadMoreButton.setAttribute('aria-busy', 'false');
    }
  } catch (error) {
    console.error(`Error loading latest news articles${category ? ` for category: ${category}` : ''}:`, error.message, error.code);
    let errorMessage = `Failed to load articles${category ? ` for "${category.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' & ')}"` : ''}: ${error.message}. `;
    if (error.code === 'permission-denied') {
      errorMessage += 'Check Firestore security rules to ensure public read access to the "articles" collection.';
    } else if (error.code === 'unavailable' || error.code === 'deadline-exceeded') {
      errorMessage += 'Network issue detected. Check your internet connection and try again.';
    } else {
      errorMessage += `Verify that articles exist in Firestore${category ? ` with category "${category}"` : ''} or try refreshing the page.`;
    }
    displayErrorMessage('#latest-news-articles', errorMessage);
    if (loadMoreButton) {
      loadMoreButton.style.display = 'none';
      loadMoreButton.textContent = 'Load More';
      loadMoreButton.disabled = false;
      loadMoreButton.setAttribute('aria-busy', 'false');
    }
  }
}

async function loadComments(articleId) {
  const commentList = document.getElementById('comment-list');
  if (!db || !commentList) return;
  const q = query(collection(db, 'articles', articleId, 'comments'), orderBy('timestamp', 'desc'));
  try {
    const snapshot = await withRetry(() => getDocs(q));
    commentList.innerHTML = '';
    if (snapshot.empty) {
      commentList.innerHTML = '<p>No comments yet.</p>';
      return;
    }
    snapshot.forEach(doc => {
      const comment = doc.data();
      const commentElement = document.createElement('div');
      commentElement.classList.add('comment');
      commentElement.innerHTML = `
        <p><strong>Anonymous</strong> on ${formatTimestamp(comment.timestamp)}</p>
        <p>${comment.text}</p>
        <button class="reply-button" data-comment-id="${doc.id}" aria-label="Reply to comment">Reply</button>
        <div class="reply-list" data-comment-id="${doc.id}"></div>
      `;
      commentList.appendChild(commentElement);
      loadReplies(articleId, doc.id);
    });
    document.querySelectorAll('.reply-button').forEach(button => {
      button.addEventListener('click', () => {
        const commentId = button.dataset.commentId;
        const replyForm = document.createElement('form');
        replyForm.classList.add('reply-form');
        replyForm.innerHTML = `
          <textarea class="reply-input" placeholder="Write a reply..." required></textarea>
          <button type="submit" class="reply-submit ripple-btn">Post Reply</button>
        `;
        button.after(replyForm);
        replyForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const replyInput = replyForm.querySelector('.reply-input');
          if (replyInput.value.trim()) {
            try {
              await withRetry(() => addDoc(collection(db, 'articles', articleId, 'comments', commentId, 'replies'), {
                text: replyInput.value.trim(),
                timestamp: serverTimestamp(),
                author: 'Anonymous'
              }));
              replyForm.remove();
              loadReplies(articleId, commentId);
            } catch (error) {
              console.error('Error adding reply:', error.message);
              displayErrorMessage(`.reply-list[data-comment-id="${commentId}"]`, 'Failed to post reply. Please try again.');
            }
          }
        });
      });
    });
  } catch (error) {
    console.error('Error loading comments:', error.message);
    displayErrorMessage('#comment-list', 'Failed to load comments. Please try again.');
  }
}

async function loadReplies(articleId, commentId) {
  const replyList = document.querySelector(`.reply-list[data-comment-id="${commentId}"]`);
  if (!db || !replyList) return;
  const q = query(collection(db, 'articles', articleId, 'comments', commentId, 'replies'), orderBy('timestamp', 'desc'));
  try {
    const snapshot = await withRetry(() => getDocs(q));
    replyList.innerHTML = '';
    snapshot.forEach(doc => {
      const reply = doc.data();
      const replyElement = document.createElement('div');
      replyElement.classList.add('reply');
      replyElement.innerHTML = `
        <p><strong>Anonymous</strong> on ${formatTimestamp(reply.timestamp)}</p>
        <p>${reply.text}</p>
      `;
      replyList.appendChild(replyElement);
    });
  } catch (error) {
    console.error('Error loading replies:', error.message);
    displayErrorMessage(`.reply-list[data-comment-id="${commentId}"]`, 'Failed to load replies. Please try again.');
  }
}

async function loadSearchResults() {
  const urlParams = new URLSearchParams(window.location.search);
  const searchQuery = urlParams.get('q')?.toLowerCase();
  const searchResults = document.getElementById('search-results');
  const searchTitle = document.getElementById('search-title');
  if (!db || !searchQuery || !searchResults || !searchTitle) return;

  searchTitle.textContent = `Search Results for "${searchQuery}"`;
  document.title = `Naija Truths - Search: ${searchQuery}`;
  document.querySelector('meta[name="description"]').setAttribute('content', `Search results for "${searchQuery}" on Naija Truths.`);
  document.querySelector('meta[property="og:title"]').setAttribute('content', `Naija Truths - Search: ${searchQuery}`);
  document.querySelector('meta[property="og:description"]').setAttribute('content', `Search results for "${searchQuery}" on Naija Truths.`);
  document.querySelector('meta[property="og:image"]').setAttribute('content', 'https://via.placeholder.com/1200x630');
  document.querySelector('meta[property="og:url"]').setAttribute('content', `https://naija-truths.netlify.app${getSearchLink(searchQuery)}`);
  document.querySelector('link[rel="canonical"]').setAttribute('href', `https://naija-truths.netlify.app${getSearchLink(searchQuery)}`);
  searchResults.innerHTML = '<p>Loading results...</p>';

  try {
    const q = query(
      collection(db, 'articles'),
      where('title_lowercase', '>=', searchQuery),
      where('title_lowercase', '<=', searchQuery + '\uf8ff'),
      orderBy('title_lowercase'),
      limit(10)
    );
    const snapshot = await withRetry(() => getDocs(q));
    searchResults.innerHTML = '';
    if (snapshot.empty) {
      searchResults.innerHTML = '<p>No results found.</p>';
      return;
    }
    snapshot.forEach(doc => {
      const article = doc.data();
      const articleElement = document.createElement('div');
      articleElement.classList.add('news-card');
      articleElement.dataset.id = doc.id;
      const imageUrl = article.image && isValidUrl(article.image) ? article.image : 'https://via.placeholder.com/400x200';
      articleElement.innerHTML = `
        <a href="${getArticleLink(article.category, article.slug)}" class="article-link">
          <img src="${imageUrl}" 
               srcset="${imageUrl} 400w, ${imageUrl} 200w, ${imageUrl} 800w" 
               sizes="(max-width: 480px) 100vw, (max-width: 767px) 80vw, 400px" 
               alt="${article.title || 'Article Image'}" 
               loading="lazy"
               onerror="this.src='https://via.placeholder.com/400x200'; this.srcset='https://via.placeholder.com/400x200 400w, https://via.placeholder.com/200x100 200w'; this.sizes='(max-width: 480px) 100vw, (max-width: 767px) 80vw, 400px';">
          <h3>${article.title || 'Untitled Article'}</h3>
          <p class="article-writer premium-writer">By ${article.writer || 'Anonymous'}</p>
          <p>${article.summary || (article.content ? article.content.substring(0, 100) + '...' : 'No summary available')}</p>
          <p class="article-time">Posted: ${formatTimestamp(article.createdAt)}</p>
          ${article.breakingNews ? '<span class="breaking-news-badge">Breaking News</span>' : ''}
          ${article.verified ? '<span class="verified-badge">Verified</span>' : ''}
        </a>
      `;
      searchResults.appendChild(articleElement);
    });
    // Update meta image if results are found
    if (snapshot.docs.length > 0) {
      const firstArticle = snapshot.docs[0].data();
      if (firstArticle.image && isValidUrl(firstArticle.image)) {
        document.querySelector('meta[property="og:image"]').setAttribute('content', firstArticle.image);
      }
    }
  } catch (error) {
    console.error('Error loading search results:', error.message);
    displayErrorMessage('#search-results', 'Failed to load search results. Please try again.');
  }
}

const loginForm = document.getElementById('admin-login-form');
if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    try {
      const userCredential = await withRetry(() => signInWithEmailAndPassword(auth, email, password));
      const user = userCredential.user;
      const idTokenResult = await user.getIdTokenResult();
      if (idTokenResult.claims.admin) {
        window.location.href = 'admin.html';
      } else {
        displayErrorMessage('#admin-login-form', 'You do not have admin privileges.');
        await signOut(auth);
      }
    } catch (error) {
      console.error('Login error:', error.message);
      displayErrorMessage('#admin-login-form', 'Login failed: Invalid credentials or network issue.');
    }
  });
}

const logoutButton = document.getElementById('logout-button');
if (logoutButton) {
  logoutButton.addEventListener('click', () => {
    signOut(auth).then(() => {
      window.location.href = 'index.html';
    }).catch(error => {
      console.error('Logout error:', error.message);
      displayErrorMessage('#admin-content', 'Failed to log out. Please try again.');
    });
  });
}

const articleForm = document.getElementById('article-form');
if (articleForm) {
  articleForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!db || !auth.currentUser) {
      displayErrorMessage('#article-form', 'You must be logged in as an admin to publish or update articles.');
      return;
    }
    const id = document.getElementById('article-id').value;
    const title = document.getElementById('article-title-input').value;
    const writer = document.getElementById('article-writer-input').value.trim();
    const summary = document.getElementById('article-summary-input').value;
    const content = quill ? quill.root.innerHTML : document.getElementById('article-content-input')?.value || '';
    const imageUrl = document.getElementById('article-image-input').value;
    const videoUrl = document.getElementById('article-video-input').value;
    const category = document.getElementById('article-category-input').value;
    const breakingNews = document.getElementById('article-breaking-news-input').checked;
    const verified = document.getElementById('article-verified-input').checked;

    if (!title || title.length < 5) {
      displayErrorMessage('#article-form', 'Title must be at least 5 characters.');
      return;
    }
    if (!content || content.length < 20) {
      displayErrorMessage('#article-form', 'Content must be at least 20 characters.');
      return;
    }
    if (!category) {
      displayErrorMessage('#article-form', 'Category is required.');
      return;
    }
    if (imageUrl && !isValidUrl(imageUrl)) {
      displayErrorMessage('#article-form', 'Image URL is invalid.');
      return;
    }
    if (videoUrl && !isValidUrl(videoUrl)) {
      displayErrorMessage('#article-form', 'Video URL is invalid.');
      return;
    }

    // Generate slug from title
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');

    const article = {
      title,
      title_lowercase: title.toLowerCase(),
      writer: writer || '',
      summary,
      content,
      image: imageUrl || '',
      video: videoUrl || '',
      category,
      slug,
      breakingNews: !!breakingNews,
      verified: !!verified,
      createdAt: serverTimestamp(),
      likes: 0,
      views: 0
    };

    console.log('Submitting article:', article);

    try {
      if (id) {
        await withRetry(() => updateDoc(doc(db, 'articles', id), article));
        alert('Article updated successfully!');
      } else {
        await withRetry(() => addDoc(collection(db, 'articles'), article));
        alert('Article published successfully!');
      }
      articleForm.reset();
      if (quill) quill.setContents([]);
      document.getElementById('article-id').value = '';
      document.getElementById('preview-section').style.display = 'none';
      localStorage.removeItem('previewArticle'); // Clear preview data
      loadAdminArticles();
    } catch (error) {
      console.error('Error publishing article:', error.message);
      displayErrorMessage('#article-form', 'Failed to publish article: ' + error.message);
    }
  });
}

const previewButton = document.getElementById('preview-button');
if (previewButton) {
  previewButton.addEventListener('click', () => {
    const title = document.getElementById('article-title-input').value;
    const writer = document.getElementById('article-writer-input').value.trim();
    const summary = document.getElementById('article-summary-input').value;
    const content = quill ? quill.root.innerHTML : document.getElementById('article-content-input')?.value || '';
    const image = document.getElementById('article-image-input').value;
    const video = document.getElementById('article-video-input').value;
    const category = document.getElementById('article-category-input').value;
    const breakingNews = document.getElementById('article-breaking-news-input').checked;
    const verified = document.getElementById('article-verified-input').checked;

    if (!title || title.length < 5) {
      displayErrorMessage('#article-form', 'Title must be at least 5 characters.');
      return;
    }
    if (!content || content.length < 20) {
      displayErrorMessage('#article-form', 'Content must be at least 20 characters.');
      return;
    }
    if (!category) {
      displayErrorMessage('#article-form', 'Category is required.');
      return;
    }
    if (image && !isValidUrl(image)) {
      displayErrorMessage('#article-form', 'Image URL is invalid.');
      return;
    }
    if (video && !isValidUrl(video)) {
      displayErrorMessage('#article-form', 'Video URL is invalid.');
      return;
    }

    // Generate slug for preview
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');

    // Store article data in localStorage for preview
    const previewArticle = {
      id: 'preview',
      title,
      writer: writer || 'Anonymous',
      summary,
      content,
      image: image || '',
      video: video || '',
      category,
      slug,
      breakingNews: !!breakingNews,
      verified: !!verified,
      createdAt: new Date(),
      likes: 0,
      views: 0
    };
    localStorage.setItem('previewArticle', JSON.stringify(previewArticle));

    // Render preview in admin page
    document.getElementById('preview-title').textContent = title;
    document.getElementById('preview-writer').textContent = `By ${writer || 'Anonymous'}`;
    document.getElementById('preview-writer').classList.add('premium-writer');
    document.getElementById('preview-summary').textContent = summary;
    document.getElementById('preview-content').innerHTML = content;
    document.getElementById('preview-category').textContent = category.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' & ');
    document.getElementById('preview-breaking-news').style.display = breakingNews ? 'block' : 'none';
    document.getElementById('preview-verified').style.display = verified ? 'block' : 'none';
    const previewImage = document.getElementById('preview-image');
    if (image && isValidUrl(image)) {
      previewImage.src = image;
      previewImage.srcset = `${image} 1200w, ${image} 768w, ${image} 480w`;
      previewImage.sizes = '(max-width: 480px) 100vw, (max-width: 768px) 80vw, 800px';
      previewImage.loading = 'lazy';
      previewImage.style.display = 'block';
    } else {
      previewImage.style.display = 'none';
    }
    const previewVideo = document.getElementById('preview-video');
    if (video && isValidUrl(video)) {
      previewVideo.src = video;
      previewVideo.style.display = 'block';
    } else {
      previewVideo.style.display = 'none';
    }
    document.getElementById('preview-section').style.display = 'block';
    document.getElementById('preview-date').textContent = `Posted: ${new Date().toLocaleDateString()}`;

    // Open article preview in new tab with environment-aware URL
    const previewUrl = getArticleLink(category, slug);
    window.open(previewUrl, '_blank');
  });
}

const clearButton = document.getElementById('clear-button');
if (clearButton) {
  clearButton.addEventListener('click', () => {
    articleForm.reset();
    if (quill) quill.setContents([]);
    document.getElementById('article-id').value = '';
    document.getElementById('preview-section').style.display = 'none';
    localStorage.removeItem('previewArticle'); // Clear preview data
  });
}

async function deleteArticle(articleId) {
  if (!db || !auth.currentUser) {
    displayErrorMessage('#article-list', 'You must be logged in as an admin to delete articles.');
    return;
  }
  if (confirm('Are you sure you want to delete this article? This action cannot be undone.')) {
    try {
      await withRetry(() => deleteDoc(doc(db, 'articles', articleId)));
      alert('Article deleted successfully!');
      loadAdminArticles();
    } catch (error) {
      console.error('Error deleting article:', error.message);
      displayErrorMessage('#article-list', 'Failed to delete article: ' + error.message);
    }
  }
}

async function loadAdminArticles() {
  const articleList = document.getElementById('article-list');
  if (!db || !articleList) return;
  try {
    const snapshot = await withRetry(() => getDocs(query(collection(db, 'articles'), orderBy('createdAt', 'desc'))));
    articleList.innerHTML = '';
    if (snapshot.empty) {
      articleList.innerHTML = '<p>No articles found.</p>';
      return;
    }
    snapshot.forEach(doc => {
      const article = doc.data();
      const articleElement = document.createElement('div');
      articleElement.classList.add('news-card');
      articleElement.innerHTML = `
        <h3>${article.title || 'Untitled Article'}</h3>
        <p class="article-writer">By ${article.writer || 'Anonymous'}</p>
        <p>${article.summary || 'No summary available'}</p>
        <p>${article.category.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' & ')}</p>
        <p class="article-time">Posted: ${formatTimestamp(article.createdAt)}</p>
        ${article.breakingNews ? '<span class="breaking-news-badge">Breaking News</span>' : ''}
        ${article.verified ? '<span class="verified-badge">Verified</span>' : ''}
        <button class="edit-button ripple-btn" data-id="${doc.id}">Edit</button>
        <button class="delete-button ripple-btn" data-id="${doc.id}">Delete</button>
      `;
      articleList.appendChild(articleElement);
    });
    document.querySelectorAll('.edit-button').forEach(button => {
      button.addEventListener('click', async () => {
        const articleId = button.dataset.id;
        const docRef = doc(db, 'articles', articleId);
        try {
          const docSnap = await withRetry(() => getDoc(docRef));
          const article = docSnap.data();
          document.getElementById('article-id').value = articleId;
          document.getElementById('article-title-input').value = article.title || '';
          document.getElementById('article-writer-input').value = article.writer || '';
          document.getElementById('article-summary-input').value = article.summary || '';
          if (quill) {
            quill.root.innerHTML = article.content || '';
          } else {
            document.getElementById('article-content-input').value = article.content || '';
          }
          document.getElementById('article-image-input').value = article.image || '';
          document.getElementById('article-video-input').value = article.video || '';
          document.getElementById('article-category-input').value = article.category || '';
          document.getElementById('article-breaking-news-input').checked = !!article.breakingNews;
          document.getElementById('article-verified-input').checked = !!article.verified;
        } catch (error) {
          console.error('Error loading article for editing:', error.message);
          displayErrorMessage('#article-list', 'Failed to load article for editing. Please try again.');
        }
      });
    });
    document.querySelectorAll('.delete-button').forEach(button => {
      button.addEventListener('click', () => {
        const articleId = button.dataset.id;
        deleteArticle(articleId);
      });
    });
  } catch (error) {
    console.error('Error loading admin articles:', error.message);
    displayErrorMessage('#article-list', 'Failed to load articles. Please try again.');
  }
}

async function searchAdminArticles() {
  const searchInput = document.getElementById('article-search-input').value.trim();
  const articleList = document.getElementById('article-list');
  if (!db || !articleList) {
    displayErrorMessage('#article-list', 'Database or article list not initialized. Please refresh the page.');
    return;
  }

  articleList.innerHTML = '<p>Loading articles...</p>';

  try {
    let snapshot;
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    
    if (!searchInput) {
      const q = query(collection(db, 'articles'), orderBy('createdAt', 'desc'), limit(50));
      snapshot = await withRetry(() => getDocs(q));
    } else if (datePattern.test(searchInput)) {
      const startDate = new Date(searchInput + 'T00:00:00Z');
      if (isNaN(startDate.getTime())) {
        articleList.innerHTML = '';
        displayErrorMessage('#article-list', 'Invalid date format. Please use YYYY-MM-DD (e.g., 2025-09-18).');
        return;
      }
      const endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 1);
      const q = query(
        collection(db, 'articles'),
        where('createdAt', '>=', startDate),
        where('createdAt', '<', endDate),
        orderBy('createdAt', 'desc'),
        limit(50)
      );
      snapshot = await withRetry(() => getDocs(q));
    } else {
      const titleQuery = query(
        collection(db, 'articles'),
        where('title_lowercase', '>=', searchInput.toLowerCase()),
        where('title_lowercase', '<=', searchInput.toLowerCase() + '\uf8ff'),
        orderBy('title_lowercase'),
        orderBy('createdAt', 'desc'),
        limit(50)
      );
      const writerQuery = query(
        collection(db, 'articles'),
        where('writer', '>=', searchInput),
        where('writer', '<=', searchInput + '\uf8ff'),
        orderBy('writer'),
        orderBy('createdAt', 'desc'),
        limit(50)
      );
      
      const [titleSnapshot, writerSnapshot] = await Promise.all([
        withRetry(() => getDocs(titleQuery)),
        withRetry(() => getDocs(writerQuery))
      ]);
      
      const articles = new Map();
      titleSnapshot.forEach(doc => articles.set(doc.id, doc));
      writerSnapshot.forEach(doc => articles.set(doc.id, doc));
      snapshot = {
        docs: Array.from(articles.values()),
        empty: articles.size === 0
      };
    }

    articleList.innerHTML = '';
    if (snapshot.empty) {
      articleList.innerHTML = '<p>No articles found for the given search.</p>';
      return;
    }

    snapshot.docs.forEach(doc => {
      const article = doc.data();
      const articleElement = document.createElement('div');
      articleElement.classList.add('news-card');
      articleElement.innerHTML = `
        <h3>${article.title || 'Untitled Article'}</h3>
        <p class="article-writer">By ${article.writer || 'Anonymous'}</p>
        <p>${article.summary || 'No summary available'}</p>
        <p>${article.category.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' & ')}</p>
        <p class="article-time">Posted: ${formatTimestamp(article.createdAt)}</p>
        ${article.breakingNews ? '<span class="breaking-news-badge">Breaking News</span>' : ''}
        ${article.verified ? '<span class="verified-badge">Verified</span>' : ''}
        <button class="edit-button ripple-btn" data-id="${doc.id}">Edit</button>
        <button class="delete-button ripple-btn" data-id="${doc.id}">Delete</button>
      `;
      articleList.appendChild(articleElement);
    });

    document.querySelectorAll('.edit-button').forEach(button => {
      button.addEventListener('click', async () => {
        const articleId = button.dataset.id;
        const docRef = doc(db, 'articles', articleId);
        try {
          const docSnap = await withRetry(() => getDoc(docRef));
          const article = docSnap.data();
          document.getElementById('article-id').value = articleId;
          document.getElementById('article-title-input').value = article.title || '';
          document.getElementById('article-writer-input').value = article.writer || '';
          document.getElementById('article-summary-input').value = article.summary || '';
          if (quill) {
            quill.root.innerHTML = article.content || '';
          } else {
            document.getElementById('article-content-input').value = article.content || '';
          }
          document.getElementById('article-image-input').value = article.image || '';
          document.getElementById('article-video-input').value = article.video || '';
          document.getElementById('article-category-input').value = article.category || '';
          document.getElementById('article-breaking-news-input').checked = !!article.breakingNews;
          document.getElementById('article-verified-input').checked = !!article.verified;
        } catch (error) {
          console.error('Error loading article for editing:', error.message);
          displayErrorMessage('#article-list', 'Failed to load article for editing. Please try again.');
        }
      });
    });
    document.querySelectorAll('.delete-button').forEach(button => {
      button.addEventListener('click', () => {
        const articleId = button.dataset.id;
        deleteArticle(articleId);
      });
    });
  } catch (error) {
    console.error('Error searching admin articles:', error.message, error.code);
    let errorMessage = 'Failed to load articles: ' + error.message + '. ';
    if (error.code === 'permission-denied') {
      errorMessage += 'Check Firestore security rules to ensure admin read access to the "articles" collection.';
    } else if (error.code === 'unavailable' || error.code === 'deadline-exceeded') {
      errorMessage += 'Network issue detected. Check your internet connection and try again.';
    } else if (error.code === 'invalid-argument') {
      errorMessage += 'Invalid search query. Ensure the date is in YYYY-MM-DD format or check the title/writer input.';
    } else {
      errorMessage += 'Please verify the search query or try refreshing the page.';
    }
    articleList.innerHTML = '';
    displayErrorMessage('#article-list', errorMessage);
  }
}

const searchForm = document.getElementById('search-form');
if (searchForm) {
  searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const searchInput = document.getElementById('search-input');
    const query = searchInput?.value.trim();
    if (query) {
      const searchUrl = getSearchLink(query);
      window.location.href = searchUrl;
    } else {
      displayErrorMessage('#search-form', 'Please enter a search query.');
    }
  });
}

document.querySelectorAll('.share-button').forEach(button => {
  button.addEventListener('click', () => {
    const platform = button.dataset.platform;
    const url = window.location.href;
    const title = document.getElementById('article-title')?.textContent || 'Naija Truths Article';
    let shareUrl;
    switch (platform) {
      case 'facebook':
        shareUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`;
        break;
      case 'x':
        shareUrl = `https://x.com/intent/post?url=${encodeURIComponent(url)}&text=${encodeURIComponent(title)}`;
        break;
      case 'whatsapp':
        shareUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(title + ' ' + url)}`;
        break;
    }
    window.open(shareUrl, '_blank');
  });
});

const loadMoreLatestButton = document.querySelector('.latest-news .load-more-button');
if (loadMoreLatestButton) {
  loadMoreLatestButton.addEventListener('click', async () => {
    loadMoreLatestButton.disabled = true;
    loadMoreLatestButton.textContent = 'Loading...';
    loadMoreLatestButton.setAttribute('aria-busy', 'true');
    const categoryFilter = document.getElementById('category-filter');
    const selectedCategory = categoryFilter ? categoryFilter.value : '';
    console.log('Load More clicked, fetching articles for category:', selectedCategory);
    await fetchLatestNewsArticles(false, loadMoreLatestButton, selectedCategory);
    loadMoreLatestButton.disabled = false;
    loadMoreLatestButton.textContent = 'Load More';
    loadMoreLatestButton.setAttribute('aria-busy', 'false');
  });
}

const loadMoreCategoryButton = document.querySelector('.category-section .load-more-button');
if (loadMoreCategoryButton) {
  loadMoreCategoryButton.addEventListener('click', async () => {
    loadMoreCategoryButton.disabled = true;
    loadMoreCategoryButton.textContent = 'Loading...';
    loadMoreCategoryButton.setAttribute('aria-busy', 'true');
    const urlParams = new URLSearchParams(window.location.search);
    const category = urlParams.get('cat');
    if (category) {
      console.log(`Load More clicked for category: ${category}`);
      await fetchCategoryArticles(category, false);
    } else {
      console.error('No category provided for Load More action');
      displayErrorMessage('#category-articles', 'Unable to load more articles: No category specified.');
      loadMoreCategoryButton.disabled = false;
      loadMoreCategoryButton.textContent = 'Load More';
      loadMoreCategoryButton.setAttribute('aria-busy', 'false');
    }
  });
}

const categoryFilter = document.getElementById('category-filter');
if (categoryFilter) {
  categoryFilter.addEventListener('change', async () => {
    const selectedCategory = categoryFilter.value;
    console.log('Category filter changed to:', selectedCategory);
    await loadLatestNewsArticles(selectedCategory);
  });
}

const hamburger = document.querySelector('.hamburger');
const mobileNav = document.querySelector('.mobile-nav');
if (hamburger && mobileNav) {
  hamburger.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = hamburger.classList.toggle('active');
    mobileNav.classList.toggle('active');
    hamburger.classList.toggle('highlight', isOpen);
    hamburger.setAttribute('aria-expanded', isOpen);
    document.body.classList.toggle('no-scroll', isOpen);
    if (isOpen) {
      mobileNav.focus();
      trapFocus(mobileNav);
    }
  });

  document.addEventListener('click', (e) => {
    if (mobileNav.classList.contains('active') && !mobileNav.contains(e.target) && !hamburger.contains(e.target)) {
      hamburger.classList.remove('active', 'highlight');
      mobileNav.classList.remove('active');
      hamburger.setAttribute('aria-expanded', 'false');
      document.body.classList.remove('no-scroll');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mobileNav.classList.contains('active')) {
      hamburger.classList.remove('active', 'highlight');
      mobileNav.classList.remove('active');
      hamburger.setAttribute('aria-expanded', 'false');
      document.body.classList.remove('no-scroll');
    }
  });

  document.querySelectorAll('.mobile-nav a').forEach(link => {
    link.addEventListener('click', () => {
      hamburger.classList.remove('active', 'highlight');
      mobileNav.classList.remove('active');
      hamburger.setAttribute('aria-expanded', 'false');
      document.body.classList.remove('no-scroll');
    });
  });
}

function trapFocus(element) {
  const focusableElements = element.querySelectorAll('a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])');
  const firstFocusable = focusableElements[0];
  const lastFocusable = focusableElements[focusableElements.length - 1];

  element.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      if (e.shiftKey && document.activeElement === firstFocusable) {
        e.preventDefault();
        lastFocusable.focus();
      } else if (!e.shiftKey && document.activeElement === lastFocusable) {
        e.preventDefault();
        firstFocusable.focus();
      }
    }
  });
}

document.querySelectorAll('a[href*="#"]').forEach(anchor => {
  anchor.addEventListener('click', (e) => {
    const href = anchor.getAttribute('href');
    if (href.startsWith('#')) {
      e.preventDefault();
      const targetId = href.substring(1);
      const targetElement = document.getElementById(targetId);
      if (targetElement) {
        targetElement.scrollIntoView({ behavior: 'smooth' });
      }
    }
  });
});

window.addEventListener('scroll', () => {
  const parallax = document.querySelector('.parallax-bg');
  if (parallax) {
    const scrollPosition = document.documentElement.scrollTop || document.body.scrollTop;
    parallax.style.transform = `translateY(${scrollPosition * 0.5}px)`;
  }
});

const scrollToTopWrapper = document.querySelector('.scroll-to-top-wrapper');
const scrollToTopButton = document.querySelector('.scroll-to-top');

if (scrollToTopWrapper && scrollToTopButton) {
  function updateScrollButtonVisibility() {
    const scrollTop = document.documentElement.scrollTop || document.body.scrollTop;
    if (scrollTop > 100) {
      scrollToTopWrapper.classList.remove('hidden');
      scrollToTopWrapper.classList.add('visible');
    } else {
      scrollToTopWrapper.classList.remove('visible');
      scrollToTopWrapper.classList.add('hidden');
    }
  }

  window.addEventListener('scroll', updateScrollButtonVisibility);

  scrollToTopButton.setAttribute('tabindex', '0');
  scrollToTopButton.setAttribute('role', 'button');
  scrollToTopButton.setAttribute('aria-label', 'Scroll to top');

  scrollToTopButton.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  scrollToTopButton.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });

  updateScrollButtonVisibility();
} else {
  console.warn('Scroll-to-top wrapper or button not found in DOM.');
}

document.addEventListener('DOMContentLoaded', () => {
  initializeFirebase().then(() => {
    if (document.getElementById('admin-login-section')) {
      onAuthStateChanged(auth, (user) => {
        if (user) {
          user.getIdTokenResult().then((idTokenResult) => {
            if (idTokenResult.claims.admin) {
              window.location.href = 'admin.html';
            }
          }).catch(error => {
            console.error('Error checking admin status:', error.message);
            displayErrorMessage('#admin-login-section', 'Failed to verify admin status. Please try again.');
          });
        }
      });
    } else if (document.getElementById('admin-content')) {
      onAuthStateChanged(auth, (user) => {
        if (user) {
          user.getIdTokenResult().then((idTokenResult) => {
            if (idTokenResult.claims.admin) {
              document.getElementById('admin-content').style.display = 'block';
              document.getElementById('logout-button').style.display = 'inline-block';
              loadAdminArticles();
              const searchButton = document.getElementById('article-search-button');
              const clearButton = document.getElementById('article-search-clear');
              if (searchButton) {
                searchButton.addEventListener('click', () => {
                  searchAdminArticles();
                });
              }
              if (clearButton) {
                clearButton.addEventListener('click', () => {
                  document.getElementById('article-search-input').value = '';
                  loadAdminArticles();
                });
              }
            } else {
              window.location.href = 'index.html';
            }
          }).catch(error => {
            console.error('Error checking admin status:', error.message);
            displayErrorMessage('#admin-content', 'Failed to verify admin status. Please try again.');
            window.location.href = 'index.html';
          });
        } else {
          window.location.href = 'index.html';
        }
      });
    } else {
      if (document.querySelector('.article-card')) {
        loadArticle();
      }
      if (document.getElementById('category-articles')) {
        loadCategoryArticles();
      }
      if (document.getElementById('politics-articles')) {
        loadPoliticsArticles();
      }
      if (document.getElementById('latest-news-articles')) {
        loadLatestNewsArticles();
      }
      if (document.getElementById('search-results')) {
        loadSearchResults();
      }
      loadArticles();
    }
    const preloader = document.getElementById('preloader');
    if (preloader) {
      preloader.style.opacity = '0';
      setTimeout(() => {
        preloader.style.display = 'none';
      }, 300);
    }
  }).catch(error => {
    console.error('DOM content load error:', error.message);
    displayErrorMessage('body', 'Failed to initialize the page. Please refresh.');
  });
});

setTimeout(() => {
  const preloader = document.getElementById('preloader');
  if (preloader && preloader.style.display !== 'none') {
    preloader.style.opacity = '0';
    preloader.style.display = 'none';
  }
}, 2000);
